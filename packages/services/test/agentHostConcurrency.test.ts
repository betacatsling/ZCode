import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import type {
  AgentCommand,
  AgentEvent,
  BackendBinding,
  BindingPlan,
  ExecutionTarget,
  HarnessCapabilities,
  SessionSpec,
} from "@zcode/shared/agent-host";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";
import { HarnessRegistry, type HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class DelayedHarness implements HarnessAdapter {
  readonly id = "delayed";
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly createStarted = deferred();
  readonly createCalls: string[] = [];
  createGate?: Promise<void>;
  failCreate = false;

  async probe(target: ExecutionTarget) {
    return target.available
      ? { support: "supported" as const }
      : { support: "unsupported" as const, reason: "target unavailable" };
  }
  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    const yes = { support: "supported" as const };
    return {
      text: yes,
      tools: yes,
      approvals: yes,
      cancelTurn: yes,
      history: yes,
      resumeExecution: yes,
      images: yes,
      modelSwitch: yes,
    };
  }
  async hostManagedSupport(target: ExecutionTarget) {
    return this.probe(target);
  }
  async create(spec: SessionSpec): Promise<BackendBinding> {
    this.createCalls.push(spec.hostSessionId);
    this.createStarted.resolve();
    await this.createGate;
    if (this.failCreate) throw new Error("delayed create failed");
    const index = this.createCalls.length;
    return {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `backend-${index}`,
      backendVersion: this.version,
      runtimeEpoch: `epoch-${index}`,
    };
  }
  async attach(_spec: SessionSpec, _binding: BackendBinding): Promise<void> {}
  async send(_command: Extract<AgentCommand, { type: "send" }>): Promise<void> {}
  async cancelTurn(_command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {}
  async resolveInteraction(
    _command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {}
  async terminate(_hostSessionId: string): Promise<void> {}
  async shutdown(): Promise<void> {}
  subscribe(_hostSessionId: string, _listener: (event: AgentEvent) => void): () => void {
    return () => {};
  }
}

function makeService(
  root: string,
  harness: HarnessAdapter,
  authorizeWorktree: (spec: SessionSpec) => Promise<boolean> = async () => true,
): AgentHostTargetService {
  const registry = new HarnessRegistry();
  registry.register(harness);
  return new AgentHostTargetService({
    root: join(root, "host"),
    target: {
      id: "target-a",
      kind: "local",
      platform: process.platform as "darwin" | "linux",
      available: true,
    },
    catalog,
    registry,
    authorizeWorktree: async (spec, realWorktreePath) =>
      authorizeWorktree({
        ...spec,
        execution: { ...spec.execution, worktreePath: realWorktreePath },
      }),
  });
}

function makeSpec(
  hostSessionId: string,
  workspaceIdentity: string,
  worktreePath: string,
): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: { targetId: "target-a", workspaceIdentity, worktreePath },
    harness: { id: "delayed", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  };
}

test("target admission reserves one owner before concurrent cross-workspace creates mount", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-concurrency-owner-"));
  const worktreeA = join(root, "worktree-a");
  const worktreeB = join(root, "worktree-b");
  await Promise.all([mkdir(worktreeA), mkdir(worktreeB)]);
  const harness = new DelayedHarness();
  const service = makeService(root, harness);
  const specA = makeSpec("same-host-id", "workspace-a", worktreeA);
  const specB = makeSpec("same-host-id", "workspace-b", worktreeB);
  try {
    const results = await Promise.allSettled([service.create(specA), service.create(specB)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(rejected);
    assert.match(String(rejected.reason), /host session ID belongs to another workspace/);
    assert.equal(harness.createCalls.length, 1);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed verification releases the admission lane for a later create", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-concurrency-release-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const harness = new DelayedHarness();
  let allow = false;
  const service = makeService(root, harness, async () => allow);
  const spec = makeSpec("retry-id", "workspace-a", worktree);
  try {
    await assert.rejects(service.create(spec), /unauthorized/);
    allow = true;
    const created = await service.create(spec);
    assert.equal(created.agentHost?.harnessId, "delayed");
    assert.equal(harness.createCalls.length, 1);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("queued attach reuses the mounted create owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-concurrency-attach-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const harness = new DelayedHarness();
  const gate = deferred();
  harness.createGate = gate.promise;
  const service = makeService(root, harness);
  const spec = makeSpec("attach-id", "workspace-a", worktree);
  try {
    const create = service.create(spec);
    await harness.createStarted.promise;
    const attach = service.attach(spec);
    gate.resolve();
    const [created, attached] = await Promise.all([create, attach]);
    assert.deepEqual(attached, created);
    assert.equal(harness.createCalls.length, 1);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("close waits an in-flight create and rejects later admissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-concurrency-close-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const harness = new DelayedHarness();
  const gate = deferred();
  harness.createGate = gate.promise;
  const service = makeService(root, harness);
  const spec = makeSpec("close-id", "workspace-a", worktree);
  try {
    const create = service.create(spec);
    await harness.createStarted.promise;
    const closing = service.close();
    gate.resolve();
    await create;
    await closing;
    await assert.rejects(service.create(spec), /target host is closing/);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("close wins a verification race and rejects a new dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-concurrency-dispatch-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const harness = new DelayedHarness();
  const verifyStarted = deferred();
  const verifyGate = deferred();
  let blockVerification = false;
  const service = makeService(root, harness, async () => {
    if (blockVerification) {
      verifyStarted.resolve();
      await verifyGate.promise;
    }
    return true;
  });
  const spec = makeSpec("dispatch-close-id", "workspace-a", worktree);
  try {
    await service.create(spec);
    blockVerification = true;
    const dispatch = service.dispatch(spec, {
      type: "send",
      commandId: "send-after-close",
      hostSessionId: spec.hostSessionId,
      turnId: "turn-1",
      text: "must reject",
    });
    await verifyStarted.promise;
    const closing = service.close();
    verifyGate.resolve();
    await assert.rejects(dispatch, /target host is closing/);
    await closing;
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Pi reserves a host ID before asynchronous worker spawn", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-concurrency-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const spec: SessionSpec = {
    schemaVersion: 1,
    hostSessionId: "pi-concurrent",
    execution: { targetId: "local", workspaceIdentity: "workspace-a", worktreePath: worktree },
    harness: { id: "pi", adapterVersion: "0.87.1" },
    modelBinding: {
      kind: "host-managed",
      selection: {
        providerId: "provider-a",
        modelId: "model-a",
        options: { reasoningLevel: "off" },
      },
    },
  };
  const selection = spec.modelBinding.selection;
  const plan: BindingPlan = {
    schemaVersion: 1,
    hostSessionId: spec.hostSessionId,
    targetId: "local",
    harnessId: "pi",
    adapterVersion: "0.87.1",
    catalogFingerprint: "fixture-v1",
    requested: spec.modelBinding,
    effective: selection,
    route: "pi-sdk",
    support: { support: "supported" },
    capabilities: {},
  };
  const model = {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "off" },
    properties: { contextWindow: 32000 },
    optionSpecs: { maxOutputTokens: { max: 1000 } },
    async *streamText() {},
  } as unknown as Model;
  let modelCalls = 0;
  const adapter = new PiHarnessAdapter({
    root: join(root, "workers"),
    modelFactory: async () => {
      modelCalls += 1;
      await Promise.resolve();
      return model;
    },
  });
  try {
    const results = await Promise.allSettled([
      adapter.create(spec, plan),
      adapter.create(spec, plan),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    assert.ok(rejected);
    assert.match(String(rejected.reason), /duplicate Pi session/);
    assert.equal(modelCalls, 1);
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
