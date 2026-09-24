import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { AgentHostTargetService, type WorkspaceAdmissionPort } from "../src/agent-host/targetService.js";
import { createRpcAgentHostService } from "../src/agent-host/rpcTargetService.js";
import { CommandJournal } from "../src/agent-host/commandJournal.js";
import { CreationJournal } from "../src/agent-host/creationJournal.js";
import { manifestPath } from "../src/agent-host/sessionManifest.js";
import { journalPath } from "../src/agent-host/journalStorage.js";

const modelBinding = { kind: "host-managed" as const, selection: { providerId: "provider", modelId: "model" } };
function spec(path: string, id: string): SessionSpecV2 {
  return { schemaVersion: 2, hostSessionId: id, projectId: "project", workspaceId: "workspace",
    execution: { targetId: "local", workspaceIdentity: "identity", worktreePath: path, worktreeGeneration: "generation-1", cwdRelativeToWorktree: "." },
    harness: { id: "mock", adapterVersion: "1.0.0" }, modelBinding };
}
const target = { id: "local", kind: "local" as const, platform: process.platform as "darwin" | "linux" | "win32", available: true };
const catalog = { fingerprint: "fingerprint-1", validateSelection: () => ({ ok: true as const }) };

async function fixture(fn: (root: string, path: string, service: AgentHostTargetService, mock: MockHarness, admission: WorkspaceAdmissionPort) => Promise<void>, mock = new MockHarness()): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-v2-host-"));
  const path = join(root, "tree");
  await mkdir(path);
  const registry = new HarnessRegistry();
  registry.registerTrusted({ schemaVersion: 1, id: "mock", name: "Mock", adapterVersion: "1.0.0" }, () => mock);
  const verify = async (candidate: SessionSpecV2) => {
    if (candidate.projectId !== "project" || candidate.workspaceId !== "workspace" || candidate.execution.worktreeGeneration !== "generation-1" ||
        candidate.execution.workspaceIdentity !== "identity" || candidate.execution.worktreePath !== path || candidate.execution.cwdRelativeToWorktree !== ".")
      throw new Error("stale or foreign workspace");
    return { canonicalCwd: path };
  };
  const admission: WorkspaceAdmissionPort = { verify, withAdmission: async (candidate, action) => action(await verify(candidate)) };
  const service = new AgentHostTargetService({ root: join(root, "sessions"), target, catalog, registry, admission });
  try { await fn(root, path, service, mock, admission); }
  finally { await service.close(); await rm(root, { recursive: true, force: true }); }
}

const send = (id: string, commandId: string) => ({ type: "send" as const, commandId, hostSessionId: id, turnId: commandId, text: "edit" });

test("v2 admission rejects legacy, foreign generation and duplicate IDs across same harness; catalog is trusted/probed", async () => fixture(async (_root, path, service) => {
  const a = spec(path, "a");
  assert.deepEqual((await service.catalogForTarget("local")).map((entry) => [entry.manifest.id, entry.availability]), [["mock", "supported"]]);
  await assert.rejects(service.catalogForTarget("foreign"), /foreign target/);
  await assert.rejects(service.create({ ...a, schemaVersion: 1 } as unknown as SessionSpecV2, "legacy"), /invalid|literal|expected/i);
  await assert.rejects(service.create({ ...a, execution: { ...a.execution, worktreeGeneration: "recreated" } }, "stale"), /stale/);
  await service.create(a, `create-${a.hostSessionId}`);
  assert.equal((await service.getSessionCapabilities(a)).approvals.support, "supported");
  assert.equal((await service.getSessionCapabilities(a)).terminateSession.support, "supported");
  await service.create(spec(path, "b"), "create-b");
  assert.deepEqual((await service.listWorkspaceSessions("workspace")).map((row) => row.spec.hostSessionId).sort(), ["a", "b"]);
  await assert.rejects(service.create({ ...a, workspaceId: "foreign" }, "foreign"), /stale/);
  await assert.rejects(service.create(a, "create-other"), /duplicate/);
  assert.deepEqual(await service.getSessionSpec({ targetId: "local", workspaceId: "workspace", hostSessionId: "a" }), a);
  assert.equal(await service.getSessionSpec({ targetId: "foreign", workspaceId: "workspace", hostSessionId: "a" }), undefined);
  assert.deepEqual(await service.getRuntimeActivity(), { running: 0, waiting: 0, uncertain: 0 });
  assert.equal((await service.queryCreationCommand("create-a"))?.receipt.status, "completed");
  assert.deepEqual(await service.create(a, "create-a"), await service.snapshot(a));
  await assert.rejects(service.create(spec(path, "different"), "create-a"), /collision|different|conflict/);
}));

test("desktop continuous events, mobile replay/rows, immutable turn route and scoped read after removal", async () => fixture(async (root, path, service, mock) => {
  const a = spec(path, "a");
  await service.create(a, `create-${a.hostSessionId}`);
  const desktop: number[] = [];
  const unsubscribe = service.subscribe(({ spec: source, event }) => { if (source.hostSessionId === "a") desktop.push(event.sequence); });
  assert.equal((await service.dispatch(a, send("a", "turn-1"))).status, "accepted");
  await mock.waitForInteraction("a");
  const pending = await service.snapshot(a);
  const concurrentReader = new AgentHostTargetService({ root: join(root, "sessions"), target, catalog,
    registry: new HarnessRegistry(), admission: { verify: async () => { throw new Error("read only"); }, withAdmission: async () => { throw new Error("read only"); } } });
  assert.equal((await concurrentReader.snapshot(a)).seq, pending.seq);
  assert.equal((await concurrentReader.queryCommand(a, "turn-1"))?.status, "execution-unknown");
  await concurrentReader.close();
  assert.deepEqual(await service.getRuntimeActivity("workspace"), { running: 0, waiting: 1, uncertain: 0 });
  assert.ok(pending.pendingInteractions.length);
  await service.dispatch(a, { type: "resolveInteraction", commandId: "deny", hostSessionId: "a", turnId: "turn-1", runtimeEpoch: pending.logEpoch, interactionId: "approval-1", decision: "deny" });
  await service.waitForIdle(a);
  unsubscribe();
  assert.deepEqual(desktop, (await service.eventsSince(a, 0)).map((event) => event.sequence));
  assert.deepEqual((await service.eventsSince(a, 2)).map((event) => event.sequence), desktop.slice(2));
  assert.equal((await service.rowsRange(a, { sessionId: "a", limit: 1 })).rows.length, 1);
  await assert.rejects(service.rowsRange(a, { sessionId: "b", limit: 1 }), /foreign rows/);
  const identity = { targetId: "local", workspaceIdentity: "identity", harnessId: "mock", hostSessionId: "a", runtimeEpoch: pending.logEpoch };
  await service.close();
  const commands = await CommandJournal.open(join(root, "sessions"), identity);
  assert.deepEqual(commands.turnRoute("turn-1")?.effective, modelBinding.selection);
  assert.equal(commands.turnRoute("turn-1")?.workspaceId, "workspace");
  assert.equal(JSON.stringify(commands.turnRoute("turn-1")).includes("secret"), false);
  await commands.close();
  await rename(path, `${path}-removed`);
  await mkdir(path); // same path is a new tree; a history read must not reattach to it.
  const history = new AgentHostTargetService({ root: join(root, "sessions"), target, catalog, registry: new HarnessRegistry(),
    admission: { verify: async () => { throw new Error("removed generation"); }, withAdmission: async () => { throw new Error("removed generation"); } } });
  assert.ok((await history.snapshot(a)).rows.window.length);
  assert.equal((await history.getSessionCapabilities(a)).viewHistory.support, "supported");
  assert.equal((await history.getSessionCapabilities(a)).text.support, "unsupported");
  assert.deepEqual(await history.getRuntimeActivity("workspace"), { running: 0, waiting: 0, uncertain: 0 });
  assert.equal((await history.queryCreationCommand("create-a"))?.receipt.status, "completed");
  assert.equal((await history.rowsRange(a, { sessionId: "a", limit: 1 })).rows.length, 1);
  assert.equal((await history.queryCommand(a, "turn-1"))?.status, "completed");
  await assert.rejects(history.attach(a), /removed generation/);
  await history.close();
}));

test("RPC creation uses one command-ID allocator while feature-off keeps durable queries and target activity", async () => fixture(async (_root, path, targetService) => {
  let enabled = true;
  const rpc = createRpcAgentHostService(targetService, () => enabled);
  try {
    const a = spec(path, "rpc");
    await rpc.service.create(a, "rpc-create");
    enabled = false;
    assert.equal((await rpc.service.queryCreationCommand("rpc-create"))?.receipt.status, "completed");
    assert.deepEqual(await rpc.service.getRuntimeActivity(), { running: 0, waiting: 0, uncertain: 0 });
    assert.equal((await rpc.service.snapshot(a)).sessionId, "rpc");
    assert.deepEqual(await rpc.service.create(a, "rpc-create"), await rpc.service.snapshot(a));
    await assert.rejects(rpc.service.create(spec(path, "blocked"), "blocked-create"), /disabled/);
    assert.equal(await rpc.service.queryCreationCommand("blocked-create"), undefined);
  } finally { rpc.dispose(); }
}));

test("interrupted create reserves command and spec before backend effect; retry never allocates again", async () => {
  let launches = 0;
  const mock = new class extends MockHarness {
    override async create(candidate: SessionSpecV2) {
      launches++;
      throw new Error(`lost backend acknowledgement for ${candidate.hostSessionId}`);
    }
  }();
  await fixture(async (_root, path, service) => {
    const a = spec(path, "interrupted");
    assert.equal((await service.getSessionCapabilities(a)).viewHistory.support, "unsupported");
    await assert.rejects(service.create(a, "lost-ack"), /lost backend acknowledgement/);
    assert.deepEqual(await service.queryCreationCommand("lost-ack"), {
      spec: a, receipt: { commandId: "lost-ack", status: "execution-unknown", reasonCode: "execution-unknown" },
    });
    await assert.rejects(service.create(a, "lost-ack"), /execution-unknown/);
    await assert.rejects(service.create(spec(path, "other"), "lost-ack"), /collision/);
    assert.equal(launches, 1);
    assert.deepEqual(await service.getRuntimeActivity(), { running: 0, waiting: 0, uncertain: 1 });
  }, mock);
});

test("orphan creation reservation without manifest still blocks target-wide maintenance", async () => fixture(async (root, path, service) => {
  const a = spec(path, "reserved-only");
  await CreationJournal.reserve(join(root, "sessions"), a, "create-orphan");
  assert.equal((await service.queryCreationCommand("create-orphan"))?.receipt.status, "execution-unknown");
  assert.deepEqual(await service.getRuntimeActivity(), { running: 0, waiting: 0, uncertain: 1 });
  assert.deepEqual(await service.getRuntimeActivity("other-workspace"), { running: 0, waiting: 0, uncertain: 0 });
}));

test("accepted send is visible to target-wide maintenance activity before backend starts", async () => {
  let unblock!: () => void;
  const gate = new Promise<void>((resolve) => { unblock = resolve; });
  const mock = new class extends MockHarness {
    override async prepareTurn(): Promise<void> { await gate; }
  }();
  try {
    await fixture(async (_root, path, service) => {
      const a = spec(path, "pending");
      await service.create(a, "create-pending");
      const sendPending = service.dispatch(a, send("pending", "turn-pending"));
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.deepEqual(await service.getRuntimeActivity(), { running: 1, waiting: 0, uncertain: 0 });
      assert.deepEqual(await service.getRuntimeActivity("other-workspace"), { running: 0, waiting: 0, uncertain: 0 });
      unblock();
      assert.equal((await sendPending).status, "accepted");
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await mock.waitForInteraction("pending"); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 5)); }
      }
      const epoch = (await service.snapshot(a)).logEpoch;
      await service.dispatch(a, { type: "cancelTurn", commandId: "cancel-pending", hostSessionId: "pending", turnId: "turn-pending", runtimeEpoch: epoch });
      await service.waitForIdle(a);
    }, mock);
  } finally { unblock(); }
});

test("server refuses uncertified approval without executing tool and rejects stale epoch", async () => fixture(async (_root, path, service, mock) => {
  const a = spec(path, "a");
  await service.create(a, `create-${a.hostSessionId}`);
  await service.dispatch(a, send("a", "turn-1"));
  await mock.waitForInteraction("a");
  const epoch = (await service.snapshot(a)).logEpoch;
  const stale = await service.dispatch(a, { type: "resolveInteraction", commandId: "stale", hostSessionId: "a", turnId: "turn-1", runtimeEpoch: "old", interactionId: "approval-1", decision: "allow" });
  assert.equal(stale.reasonCode, "stale-interaction");
  const unsupported = await service.dispatch(a, { type: "resolveInteraction", commandId: "unsupported", hostSessionId: "a", turnId: "turn-1", runtimeEpoch: epoch, interactionId: "approval-1", decision: "allow" });
  assert.equal(unsupported.reasonCode, "unsupported");
  await service.dispatch(a, { type: "cancelTurn", commandId: "stop", hostSessionId: "a", turnId: "turn-1", runtimeEpoch: epoch });
  await service.waitForIdle(a);
  assert.equal((await service.eventsSince(a, 0)).some((event) => event.kind === "tool.finished" && event.outcome === "success"), false);
}, new class extends MockHarness {
  override async capabilities(target: typeof target) {
    return { ...await super.capabilities(target), approvals: { support: "unsupported" as const, reason: "not enforceable" } };
  }
}));

test("legacy manifest stays readable without adapter, but v1 and future versions never write", async () => fixture(async (root, path, service) => {
  const v1 = { schemaVersion: 1 as const, hostSessionId: "old", execution: { targetId: "local", workspaceIdentity: "identity", worktreePath: path },
    harness: { id: "mock", adapterVersion: "1.0.0" }, modelBinding };
  await mkdir(join(root, "sessions"));
  await writeFile(manifestPath(join(root, "sessions"), v1), JSON.stringify({ schemaVersion: 1, state: "running", spec: v1,
    plan: { schemaVersion: 1, hostSessionId: "old", targetId: "local", harnessId: "mock", adapterVersion: "1.0.0", catalogFingerprint: "old", requested: modelBinding,
      effective: modelBinding.selection, route: "mock", support: { support: "supported" }, capabilities: {} },
    binding: { hostSessionId: "old", backendSessionId: "native-old", backendVersion: "1.0.0", runtimeEpoch: "epoch-old" } }));
  assert.equal((await service.snapshot(v1)).sessionId, "old");
  assert.deepEqual(await readdir(join(root, "sessions")), [manifestPath(join(root, "sessions"), v1).split("/").at(-1)]);
  assert.equal((await service.getSessionCapabilities(v1)).viewHistory.support, "supported");
  assert.equal((await service.getSessionCapabilities(v1)).approvals.support, "unsupported");
  await assert.rejects(service.attach(v1 as unknown as SessionSpecV2));
  await assert.rejects(service.dispatch(v1 as unknown as SessionSpecV2, send("old", "no-write")));
  await assert.rejects(service.create({ ...spec(path, "future"), schemaVersion: 3 } as unknown as SessionSpecV2, "future"));
}));

test("source gap fences execution while desktop/mobile recover committed prefix through snapshot", async () => {
  const mock = new MockHarness({ gapBeforeText: true });
  await fixture(async (_root, path, service) => {
    const a = spec(path, "gap");
    await service.create(a, `create-${a.hostSessionId}`);
    await service.dispatch(a, send("gap", "turn-gap"));
    await mock.waitForInteraction("gap");
    const snapshot = await service.snapshot(a);
    assert.equal(snapshot.seq, 1);
    assert.deepEqual((await service.eventsSince(a, 0)).map((event) => event.sequence), [1]);
    assert.deepEqual(await service.getRuntimeActivity("workspace"), { running: 0, waiting: 0, uncertain: 1 });
    assert.equal((await service.dispatch(a, send("gap", "another"))).reasonCode, "execution-unknown");
    assert.equal((await service.dispatch(a, { type: "detach", commandId: "detach", hostSessionId: "gap" })).status, "completed");
    const receipt = await service.dispatch(a, { type: "terminateSession", commandId: "terminate", hostSessionId: "gap" });
    assert.equal(receipt.status, "completed");
  }, mock);
});

test("turn route is durable before prepare/send and later catalog changes affect only next turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-frozen-model-"));
  const path = join(root, "tree");
  await mkdir(path);
  let fingerprint = "catalog-1";
  const registry = new HarnessRegistry();
  const order: string[] = [];
  class PreparedMock extends MockHarness {
    override async prepareTurn(_spec: SessionSpecV2, input: { turnId: string }): Promise<void> { order.push(`prepare:${input.turnId}`); }
    override async waitForInteraction(hostSessionId: string): Promise<void> {
      for (let attempt = 0; attempt < 100 && !order.at(-1)?.startsWith("send:"); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      return super.waitForInteraction(hostSessionId);
    }
    override async send(command: ReturnType<typeof send>): Promise<void> {
      const identity = { targetId: "local", workspaceIdentity: "identity", harnessId: "mock", hostSessionId: "a", runtimeEpoch: this.epoch("a") };
      const lines = (await readFile(journalPath(join(root, "sessions"), identity, "commands"), "utf8")).trim().split("\n");
      const route = lines.map((line) => JSON.parse(line) as { frozenRoute?: { catalogFingerprint: string; turnId: string } }).find((row) => row.frozenRoute?.turnId === command.turnId);
      assert.equal(route?.frozenRoute?.catalogFingerprint, fingerprint);
      order.push(`send:${command.turnId}`);
      return super.send(command);
    }
  }
  const mock = new PreparedMock();
  registry.registerTrusted({ schemaVersion: 1, id: "mock", name: "Mock", adapterVersion: "1.0.0" }, () => mock);
  const admission: WorkspaceAdmissionPort = { verify: async () => ({ canonicalCwd: path }), withAdmission: async (_spec, action) => action({ canonicalCwd: path }) };
  const service = new AgentHostTargetService({ root: join(root, "sessions"), target, registry, admission,
    catalog: { get fingerprint() { return fingerprint; }, validateSelection: () => ({ ok: true }) } });
  try {
    const a = spec(path, "a");
    await service.create(a, `create-${a.hostSessionId}`);
    for (const turn of ["one", "two"]) {
      assert.equal((await service.dispatch(a, send("a", turn))).status, "accepted");
      await mock.waitForInteraction("a");
      const epoch = (await service.snapshot(a)).logEpoch;
      await service.dispatch(a, { type: "resolveInteraction", commandId: `deny-${turn}`, hostSessionId: "a", turnId: turn,
        runtimeEpoch: epoch, interactionId: "approval-1", decision: "deny" });
      await service.waitForIdle(a);
      fingerprint = "catalog-2";
    }
    assert.deepEqual(order, ["prepare:one", "send:one", "prepare:two", "send:two"]);
  } finally { await service.close(); await rm(root, { recursive: true, force: true }); }
});

test("parallel sends on one host admit only one and uncertain crash fences next send", async () => fixture(async (_root, path, service, mock) => {
  const a = spec(path, "a");
  await service.create(a, `create-${a.hostSessionId}`);
  const receipts = await Promise.all([service.dispatch(a, send("a", "turn-1")), service.dispatch(a, send("a", "turn-2"))]);
  assert.deepEqual(receipts.map((receipt) => receipt.status), ["accepted", "rejected"]);
  await mock.waitForInteraction("a");
  const epoch = (await service.snapshot(a)).logEpoch;
  await service.dispatch(a, { type: "resolveInteraction", commandId: "deny", hostSessionId: "a", turnId: "turn-1", runtimeEpoch: epoch, interactionId: "approval-1", decision: "deny" });
  await service.waitForIdle(a);
  assert.equal((await service.dispatch(a, send("a", "turn-1"))).status, "duplicate");
}));
