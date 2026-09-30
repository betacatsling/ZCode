import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { claudeSessionProfileRoot } from "../src/agent-adapters/claude/claudeProfile.js";
import {
  claudeAdapterHarness,
  eventsOf,
  listeningServers,
  startTurn,
  type ClaudeAdapterHarness,
} from "./fixtures/claudeAdapterHarness.js";
import { fakeClaudeModel } from "./fixtures/claudeUnitFixtures.js";

// A8: every startup failure step releases what it allocated (grant, hook server, process,
// registry reservation) and surfaces a clear error. The shared target Gateway stays up by design;
// only an adapter-owned TargetModelGateway is closed, at shutdown.

async function assertNothingAllocated(h: ClaudeAdapterHarness, servers: number): Promise<void> {
  assert.deepEqual(h.grants.created, [], "no grant");
  assert.equal(h.launches.length, 0, "no process");
  assert.equal(await listeningServers(), servers, "neither the Gateway nor a hook server listens");
}

async function assertCanStartAgain(h: ClaudeAdapterHarness): Promise<void> {
  const binding = await h.adapter.create(h.spec, h.plan);
  assert.equal(binding.hostSessionId, h.spec.hostSessionId, "the start reservation was released");
}

test("a prepared binding for another plan is refused before anything is allocated", async (t) => {
  const servers = await listeningServers();
  const h = await claudeAdapterHarness(t);
  const other = { ...h.plan, catalogFingerprint: "catalog-other" };
  await assert.rejects(
    h.adapter.create(h.spec, h.plan, { plan: other, model: fakeClaudeModel() }),
    /Claude startup received another prepared plan/,
  );
  await assertNothingAllocated(h, servers);
  await assertCanStartAgain(h);
});

test("modelFactory, Model drift and a revoked selection fail before the Gateway starts", async (t) => {
  const servers = await listeningServers();
  let factory: () => ReturnType<typeof fakeClaudeModel> = () => {
    throw new Error("model factory exploded");
  };
  const authorized = { value: true };
  const h = await claudeAdapterHarness(t, {
    adapter: { modelFactory: () => factory(), isSelectionAuthorized: () => authorized.value },
  });
  await assert.rejects(h.adapter.create(h.spec, h.plan), /model factory exploded/);
  await assertNothingAllocated(h, servers);

  factory = () => fakeClaudeModel({ modelId: "drifted-model" });
  await assert.rejects(
    h.adapter.create(h.spec, h.plan),
    /Claude Model differs from its captured Messages binding or effort/,
  );
  await assertNothingAllocated(h, servers);

  factory = () => fakeClaudeModel();
  authorized.value = false;
  await assert.rejects(
    h.adapter.create(h.spec, h.plan),
    /Claude Model selection is no longer authorized/,
  );
  await assertNothingAllocated(h, servers);

  authorized.value = true;
  await assertCanStartAgain(h);
});

test("a closed Target Gateway is reported before any grant or process", async (t) => {
  const servers = await listeningServers();
  const h = await claudeAdapterHarness(t);
  await h.targetModelGateway.close();
  await assert.rejects(h.adapter.create(h.spec, h.plan), /Target Model Gateway is closed/);
  await assertNothingAllocated(h, servers);
});

test("a prior binding with another version or owner revokes the fresh grant", async (t) => {
  const h = await claudeAdapterHarness(t);
  const servers = await listeningServers();
  const binding = {
    hostSessionId: h.spec.hostSessionId,
    backendSessionId: "native-prior",
    backendVersion: "2.0.0",
    runtimeEpoch: "epoch-prior",
  };
  await assert.rejects(
    h.adapter.attach(h.spec, binding, 4, h.plan),
    /Claude backend binding version or owner differs/,
  );
  await assert.rejects(
    h.adapter.attach(
      h.spec,
      { ...binding, backendVersion: h.plan.adapterVersion, hostSessionId: "someone-else" },
      4,
      h.plan,
    ),
    /Claude backend binding version or owner differs/,
  );
  assert.equal(h.grants.created.length, 2);
  assert.deepEqual(h.grants.revoked, h.grants.created);
  assert.equal(h.launches.length, 0);
  assert.equal(
    await listeningServers(),
    servers + 1,
    "only the shared Gateway listens; no hook server",
  );
});

test("a profile write failure revokes the grant and closes the hook server", async (t) => {
  const h = await claudeAdapterHarness(t);
  const servers = await listeningServers();
  const configDir = join(claudeSessionProfileRoot(h.root, h.spec), "claude-config");
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(join(configDir, "settings.json"), "{}", { mode: 0o600 });
  await assert.rejects(
    h.adapter.create(h.spec, h.plan),
    /refusing to overwrite an unmanaged Claude profile file/,
  );
  assert.equal(h.grants.created.length, 1);
  assert.deepEqual(h.grants.revoked, h.grants.created);
  assert.equal(h.launches.length, 0);
  assert.equal(await listeningServers(), servers + 1, "the hook server was closed");
});

test("a rejected launch revokes the grant, closes the hook server and frees the session", async (t) => {
  let failLaunch = true;
  const h = await claudeAdapterHarness(t, {
    behavior: {
      onLaunch: () => {
        if (failLaunch) throw new Error("spawn EACCES");
      },
    },
  });
  const servers = await listeningServers();
  await assert.rejects(h.adapter.create(h.spec, h.plan), /spawn EACCES/);
  assert.equal(h.launches.length, 1);
  assert.deepEqual(h.grants.revoked, h.grants.created);
  assert.deepEqual(h.onProcess, []);
  assert.equal(await listeningServers(), servers + 1, "the hook server was closed");
  failLaunch = false;
  await assertCanStartAgain(h);
});

test("an onProcess observer failure terminates the launched process and revokes the grant", async (t) => {
  const h = await claudeAdapterHarness(t, {
    adapter: {
      onProcess: () => {
        throw new Error("observer failed");
      },
    },
  });
  const servers = await listeningServers();
  await assert.rejects(h.adapter.create(h.spec, h.plan), /observer failed/);
  const [process] = h.launches;
  assert.deepEqual(process?.calls, ["terminate"]);
  assert.deepEqual(h.grants.revoked, h.grants.created);
  assert.equal(await process!.gatewayStatus(), 401);
  assert.equal(await process!.preToolUse("tool-1", "Read", { file_path: "x" }), "unreachable");
  assert.equal(await listeningServers(), servers + 1);
});

test("a selection revoked while the process starts stops the runtime and frees the session", async (t) => {
  const authorized = { value: true };
  let launchCount = 0;
  const h = await claudeAdapterHarness(t, {
    adapter: { isSelectionAuthorized: () => authorized.value },
    behavior: {
      onLaunch: () => {
        if (launchCount++ === 0) authorized.value = false;
      },
    },
  });
  const servers = await listeningServers();
  await assert.rejects(
    h.adapter.create(h.spec, h.plan),
    /Claude Model selection was revoked during process startup/,
  );
  const [process] = h.launches;
  assert.deepEqual(process?.calls, ["terminate"], "stopped once, not terminated again");
  assert.equal(h.grants.created.length, 1);
  assert.ok(h.grants.revoked.every((id) => id === h.grants.created[0]));
  assert.equal(await process!.gatewayStatus(), 401);
  assert.equal(await listeningServers(), servers + 1);
  authorized.value = true;
  h.launches.length = 0;
  await assertCanStartAgain(h);
});

test("messages and failures seen before the runtime exists are replayed onto it", async (t) => {
  const h = await claudeAdapterHarness(t, {
    behavior: {
      onLaunch: (process) => {
        if (process.resumed) return;
        process.init();
        process.emit({ type: "system", subtype: { unexpected: true } });
        process.fail(new Error("stderr said goodbye"));
      },
    },
  });
  const binding = await h.adapter.create(h.spec, h.plan);
  assert.equal(binding.hostSessionId, h.spec.hostSessionId, "startup still returns the binding");
  assert.deepEqual(
    eventsOf(h.events, "session.error").map((event) => event.code),
    ["claude-process-failure"],
    "the replayed protocol failure fails the runtime once; the early failure is then a no-op",
  );
  assert.deepEqual(h.grants.revoked, h.grants.created);
  // The failed runtime is replaced (resumed) on the next turn instead of accepting input.
  const { sending } = await startTurn(h, "turn-after-early-failure");
  assert.equal(h.launches.length, 2);
  assert.equal(h.launches[1]!.resumed, true);
  assert.deepEqual(h.launches[0]!.calls, ["terminate"]);
  h.launches[1]!.result();
  await sending;
});
