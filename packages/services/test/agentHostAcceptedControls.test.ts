import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderRegistryService } from "@zcode/provider";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { AgentHostTargetService, type WorkspaceAdmissionPort } from "../src/agent-host/targetService.js";
import { createLazyTargetAgentHostService } from "../src/agent-host/lazyTargetService.js";

const target = { id: "local", kind: "local" as const, platform: process.platform as "darwin" | "linux" | "win32", available: true };
const catalog = { fingerprint: "fingerprint", validateSelection: () => ({ ok: true as const }) };
const spec = (path: string): SessionSpecV2 => ({ schemaVersion: 2, hostSessionId: "accepted", projectId: "p", workspaceId: "w",
  execution: { targetId: "local", workspaceIdentity: "identity", worktreePath: path, worktreeGeneration: "generation-1", cwdRelativeToWorktree: "." },
  harness: { id: "mock", adapterVersion: "1.0.0" }, modelBinding: { kind: "host-managed", selection: { providerId: "provider", modelId: "model" } } });

async function fixture(run: (root: string, path: string, host: AgentHostTargetService, mock: MockHarness, scope: { archived: boolean; removed: boolean; checks: number }, admission: WorkspaceAdmissionPort) => Promise<void>, mock = new MockHarness()) {
  const root = await mkdtemp(join(tmpdir(), "accepted-controls-"));
  const path = join(root, "tree");
  await mkdir(path);
  const scope = { archived: false, removed: false, checks: 0 };
  const verify = async (candidate: SessionSpecV2) => {
    scope.checks++;
    if (scope.archived) throw new Error("archived workspace");
    if (scope.removed || candidate.execution.worktreeGeneration !== "generation-1" || candidate.execution.worktreePath !== path) throw new Error("removed generation");
    return { canonicalCwd: path };
  };
  const admission: WorkspaceAdmissionPort = { verify, withAdmission: async (candidate, action) => action(await verify(candidate)) };
  const registry = new HarnessRegistry();
  registry.registerTrusted({ schemaVersion: 1, id: "mock", name: "Mock", adapterVersion: "1.0.0" }, () => mock);
  const host = new AgentHostTargetService({ root: join(root, "sessions"), target, catalog, registry, admission });
  try { await run(root, path, host, mock, scope, admission); }
  finally { await host.close(); await rm(root, { recursive: true, force: true }); }
}

async function waitForInteraction(mock: MockHarness) {
  for (let i = 0; i < 100; i++) {
    try { await mock.waitForInteraction("accepted"); return; }
    catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
  }
  throw new Error("approval never arrived");
}

const send = { type: "send" as const, commandId: "send", hostSessionId: "accepted", turnId: "turn", text: "edit" };

test("archive does not strand accepted deny or cancel, but rejects new execution and tool allow", async () => fixture(async (_root, path, host, mock, scope) => {
  const session = spec(path);
  await host.create(session, "create");
  assert.equal((await host.dispatch(session, send)).status, "accepted");
  await waitForInteraction(mock);
  const epoch = (await host.snapshot(session)).logEpoch;
  scope.archived = true;
  const checks = scope.checks;
  assert.equal((await host.dispatch(session, send)).status, "duplicate");
  await assert.rejects(host.dispatch(session, { ...send, text: "different" }), /duplicate-id/);
  assert.equal(mock.epoch("accepted"), epoch);
  const deny = { type: "resolveInteraction" as const, commandId: "deny", hostSessionId: "accepted", runtimeEpoch: epoch, turnId: "turn", interactionId: "approval-1", decision: "deny" as const };
  assert.equal((await host.dispatch(session, { ...deny, commandId: "stale", turnId: "old" })).reasonCode, "stale-interaction");
  await assert.rejects(host.dispatch(session, { ...deny, commandId: "allow", decision: "allow" }), /archived/);
  assert.equal((await host.dispatch(session, deny)).status, "completed");
  assert.equal((await host.dispatch(session, deny)).status, "duplicate");
  assert.equal(scope.checks, checks + 1);
  scope.archived = false;
  await host.waitForIdle(session);
  scope.archived = true;
  assert.equal((await host.queryCommand(session, "deny"))?.status, "completed");
  await assert.rejects(host.dispatch(session, { ...send, commandId: "new", turnId: "new" }), /archived/);
}));

test("archive during running turn still delivers cancel and later pending deny without new admission", async () => fixture(async (_root, path, host, mock, scope) => {
  const session = spec(path);
  await host.create(session, "create");
  await host.dispatch(session, send);
  const epoch = (await host.snapshot(session)).logEpoch;
  assert.deepEqual(await host.getRuntimeActivity("w"), { running: 1, waiting: 0, uncertain: 0 });
  scope.archived = true;
  const checks = scope.checks;
  assert.equal((await host.dispatch(session, { type: "cancelTurn", commandId: "cancel-running", hostSessionId: "accepted", runtimeEpoch: epoch, turnId: "turn" })).status, "completed");
  await waitForInteraction(mock);
  assert.equal((await host.dispatch(session, { type: "resolveInteraction", commandId: "deny-after-cancel", hostSessionId: "accepted", runtimeEpoch: epoch,
    turnId: "turn", interactionId: "approval-1", decision: "deny" })).status, "completed");
  assert.equal(scope.checks, checks);
  scope.archived = false;
  await host.waitForIdle(session);
}, new MockHarness({ delayMs: 500 })));

test("previously accepted allow only retries its identical receipt after archive; new allow needs a held gate", async () => fixture(async (_root, path, host, mock, scope, admission) => {
  const session = spec(path);
  await host.create(session, "create");
  await host.dispatch(session, send);
  await waitForInteraction(mock);
  const epoch = (await host.snapshot(session)).logEpoch;
  const allow = { type: "resolveInteraction" as const, commandId: "allow", hostSessionId: "accepted", runtimeEpoch: epoch,
    turnId: "turn", interactionId: "approval-1", decision: "allow" as const };
  const heldGate = admission.withAdmission;
  admission.withAdmission = async () => { throw new Error("lease frozen during approval"); };
  await assert.rejects(host.dispatch(session, allow), /lease frozen/);
  assert.equal(await host.queryCommand(session, "allow"), undefined);
  admission.withAdmission = heldGate;
  assert.equal((await host.dispatch(session, allow)).status, "completed");
  scope.archived = true;
  assert.equal((await host.dispatch(session, allow)).status, "duplicate");
  await assert.rejects(host.dispatch(session, { ...allow, decision: "deny" }), /duplicate-id/);
  await assert.rejects(host.dispatch(session, { ...allow, commandId: "new-allow" }), /archived/);
  scope.archived = false;
  await host.waitForIdle(session);
}));

test("removed/rebuilt scope permits only exact mounted cancellation, not new send or cold controls", async () => fixture(async (root, path, host, mock, scope) => {
  const session = spec(path);
  await host.create(session, "create");
  await host.dispatch(session, send);
  await waitForInteraction(mock);
  const epoch = (await host.snapshot(session)).logEpoch;
  scope.removed = true;
  const checks = scope.checks;
  const stale = { ...session, execution: { ...session.execution, worktreeGeneration: "generation-2" } };
  await assert.rejects(host.dispatch(stale, { type: "cancelTurn", commandId: "forged", hostSessionId: "accepted", runtimeEpoch: epoch, turnId: "turn" }), /mismatch/);
  assert.equal((await host.dispatch(session, { type: "cancelTurn", commandId: "stale", hostSessionId: "accepted", runtimeEpoch: epoch, turnId: "old" })).reasonCode, "stale-turn");
  assert.equal((await host.dispatch(session, { type: "cancelTurn", commandId: "cancel", hostSessionId: "accepted", runtimeEpoch: epoch, turnId: "turn" })).status, "completed");
  assert.equal(scope.checks, checks);
  await assert.rejects(host.dispatch(session, { ...send, commandId: "new", turnId: "new" }), /removed/);
  assert.equal((await host.snapshot(session)).sessionId, "accepted");
  assert.equal((await host.queryCommand(session, "cancel"))?.status, "completed");
  const cold = new AgentHostTargetService({ root: join(root, "sessions"), target, catalog, registry: new HarnessRegistry(), admission: {
    verify: async () => { throw new Error("removed"); }, withAdmission: async () => { throw new Error("removed"); },
  } });
  await assert.rejects(cold.dispatch(session, { type: "cancelTurn", commandId: "cold", hostSessionId: "accepted", runtimeEpoch: epoch, turnId: "turn" }), /not attached/);
  assert.equal((await cold.snapshot(session)).sessionId, "accepted");
  await cold.close();
}));

test("feature-off lazy wrapper reads durable history and completed create retry without Pi startup", async () => fixture(async (root, path, host) => {
  const session = spec(path);
  const created = await host.create(session, "create");
  let starts = 0;
  const registry = { start: async () => { starts++; throw new Error("worker started"); } } as unknown as ProviderRegistryService;
  const lazy = createLazyTargetAgentHostService({ root, target, registry, allowNewSessions: () => false, admission: {
    verify: async () => { throw new Error("disabled"); }, withAdmission: async () => { throw new Error("disabled"); },
  } });
  try {
    assert.equal((await lazy.service.snapshot(session)).sessionId, "accepted");
    assert.equal((await lazy.service.queryCreationCommand("create"))?.receipt.status, "completed");
    assert.deepEqual(await lazy.service.create(session, "create"), created);
    await assert.rejects(lazy.service.create({ ...session, hostSessionId: "other" }, "create"), /disabled/);
    await assert.rejects(lazy.service.dispatch(session, { type: "cancelTurn", commandId: "control", hostSessionId: "accepted", runtimeEpoch: created.logEpoch, turnId: "turn" }), /not attached|disabled/);
    assert.equal(starts, 0);
  } finally { await lazy.dispose(); }
}));
