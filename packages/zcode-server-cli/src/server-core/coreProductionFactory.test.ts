import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
// Regression imports the public production export, never an injected test authority.
import { createCoreAuthority } from "@zcode/services/node";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";

test("public factory: default Core subprocess, duplicate writer, reconnect, dispose and restart", async () => {
  assert.equal(typeof createCoreAuthority, "function");
  const dir = await mkdtemp(join(tmpdir(), "core-production-"));
  const layout = resolveServerLayout(join(dir, "install"));
  await ensureServerInstallOwnership(layout);
  const provider = join(dir, "builtin.json");
  await writeFile(
    provider,
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          modelRules: [],
          modelApiRules: [],
          providerSiteRules: [],
          templateModelRules: [],
          builtinProviderModelRules: [],
        },
      },
    }),
  );
  const fixture = fileURLToPath(
    new URL("./coreProductionFactoryChild.fixture.ts", import.meta.url),
  );
  const children: ChildProcess[] = [];
  async function boot(mode: "core" | "direct" = "core") {
    const child = fork(fixture, mode === "direct" ? ["direct"] : [], {
      execArgv: ["--import", import.meta.resolve("tsx")],
      env: {
        ...process.env,
        HOME: dir,
        ZCODE_DATA_BASE_DIR: dir,
        ZCODE_SERVER_ROOT: layout.serverRoot,
        ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
      },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (part: Buffer) => {
      stderr += part.toString();
    });
    const message = (predicate: (m: unknown) => boolean) =>
      new Promise<unknown>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Core reply timed out: ${stderr}`));
        }, 15_000);
        function received(value: unknown) {
          if (predicate(value)) {
            cleanup();
            resolve(value);
          }
        }
        function exited(code: number | null) {
          cleanup();
          reject(new Error(`Core exited ${code}: ${stderr}`));
        }
        function cleanup() {
          clearTimeout(timeout);
          child.off("message", received);
          child.off("exit", exited);
        }
        child.on("message", received);
        child.once("exit", exited);
      });
    const ready = (await message(
      (m) =>
        !!m &&
        typeof m === "object" &&
        "type" in m &&
        m.type === (mode === "direct" ? "direct" : "ready"),
    )) as {
      host: string;
      port: number;
      revision?: number;
      activity?: unknown;
      nativeBeforeFence?: { uncertain: number };
      afterWorkerExit?: { uncertain: number };
      staleReleaseRejected?: boolean;
      sidebar?: { projects: unknown[]; workspaces: unknown[]; sessions: unknown[] };
      nativeSourceUnavailable?: boolean;
    };
    return { child, ready, message, stderr: () => stderr };
  }
  try {
    const first = await boot();
    const url = `http://${first.ready.host}:${first.ready.port}/api/server-info`;
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url);
      assert.equal(response.status, 200);
      await response.body?.cancel(); // client detach cannot dispose the Core owner
    }
    const duplicate = first.message(
      (m) => !!m && typeof m === "object" && "type" in m && m.type === "duplicate",
    );
    first.child.send("probe-duplicate");
    assert.deepEqual(duplicate && (await duplicate), { type: "duplicate", rejected: true });
    const requestId = randomUUID();
    const frozen = first.message(
      (m) =>
        !!m &&
        typeof m === "object" &&
        "type" in m &&
        m.type === "maintenance" &&
        "requestId" in m &&
        m.requestId === requestId,
    );
    first.child.send({ command: "maintenance-begin", requestId });
    const lease = (await frozen) as { leaseId?: string; nativeActivity?: unknown };
    assert.ok(
      lease.leaseId,
      `real process census must issue an idle lease only after a verified fence: ${first.stderr()}`,
    );
    assert.deepEqual(lease.nativeActivity, { running: 0, waiting: 0, uncertain: 0 });
    const staleId = randomUUID();
    const stale = first.message(
      (m) =>
        !!m &&
        typeof m === "object" &&
        "type" in m &&
        m.type === "maintenance" &&
        "requestId" in m &&
        m.requestId === staleId,
    );
    first.child.send({ command: "maintenance-release", requestId: staleId, leaseId: randomUUID() });
    assert.equal(((await stale) as { leaseId?: string }).leaseId, undefined);
    const releaseId = randomUUID();
    const released = first.message(
      (m) =>
        !!m &&
        typeof m === "object" &&
        "type" in m &&
        m.type === "maintenance" &&
        "requestId" in m &&
        m.requestId === releaseId,
    );
    first.child.send({
      command: "maintenance-release",
      requestId: releaseId,
      leaseId: lease.leaseId,
    });
    assert.equal(((await released) as { leaseId?: string }).leaseId, lease.leaseId);
    const stopped = new Promise<void>((resolve) => first.child.once("close", () => resolve()));
    first.child.send({ command: "shutdown" });
    await stopped;
    assert.equal(first.child.exitCode, 0);
    const restarted = await boot(); // same durable installation + profile after lock release
    const response = await fetch(
      `http://${restarted.ready.host}:${restarted.ready.port}/api/server-info`,
    );
    assert.equal(response.status, 200);
    await response.body?.cancel();
    const done = new Promise<void>((resolve) => restarted.child.once("close", () => resolve()));
    restarted.child.send({ command: "shutdown" });
    await done;
    assert.equal(restarted.child.exitCode, 0);
    const direct = await boot("direct");
    assert.equal(direct.ready.revision, 0); // real Catalog writer after restart, not an empty-index fixture
    assert.ok(direct.ready.activity);
    assert.ok(
      (direct.ready.nativeBeforeFence?.uncertain ?? 0) > 0,
      "an unfrozen resident CLI worker must never be reported as idle",
    );
    assert.ok(
      (direct.ready.afterWorkerExit?.uncertain ?? 0) > 0,
      "cached frozen CLI activity cannot survive worker exit",
    );
    assert.equal(direct.ready.staleReleaseRejected, true);
    assert.deepEqual(direct.ready.sidebar?.projects, []);
    assert.deepEqual(direct.ready.sidebar?.workspaces, []);
    assert.deepEqual(direct.ready.sidebar?.sessions, []);
    assert.equal(direct.ready.nativeSourceUnavailable, false); // both native writers initialized at boot
    const partial = await direct.message(
      (m) => !!m && typeof m === "object" && "type" in m && m.type === "partial-boot",
    );
    assert.deepEqual(partial, { type: "partial-boot", rejected: true });
    if (direct.child.exitCode === null)
      await new Promise<void>((resolve) => direct.child.once("close", () => resolve()));
    assert.equal(direct.child.exitCode, 0);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await rm(dir, { recursive: true, force: true });
  }
});
