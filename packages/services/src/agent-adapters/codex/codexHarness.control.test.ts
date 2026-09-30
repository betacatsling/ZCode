import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import {
  bindingPlanSchema,
  sessionSpecSchema,
  type AgentEvent,
  type BindingPlan,
  type ExecutionTarget,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type {
  ModelGateway,
  ModelGatewayGrant,
  TargetModelGatewayPort,
} from "@zcode/services/model-gateway";
import {
  type CodexAppServerProcessOptions,
  type CodexJsonRpcMessage,
  type JsonRpcId,
} from "./codexAppServerProcess.js";
import { CodexHarnessAdapter } from "./codexHarnessAdapter.js";
import { codexSessionProfileRoot } from "./codexProfile.js";

const SELECTION = {
  providerId: "fake-provider",
  modelId: "fake-model",
  options: { reasoningLevel: "off" },
};

test("control plane stays experimental until a model execution trace exists", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-capability-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "codex");
  await writeFile(
    executable,
    "#!/usr/bin/env node\nprocess.stdout.write('codex-cli 0.157.1\\n');\n",
    {
      mode: 0o700,
    },
  );
  const target: ExecutionTarget = {
    id: "target-1",
    kind: "local",
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const adapter = new CodexHarnessAdapter({
    root,
    executablePath: executable,
    targetModelGateway: new FakeGatewayPort(),
    isOpenAiResponsesSelection: () => true,
    modelFactory: () => {
      throw new Error("capability probe must not construct a model");
    },
    fakeModelCompatibilityEvidence: (selection) =>
      selection.modelId === "with-fixture"
        ? { providerId: selection.providerId, modelId: selection.modelId, fixtureId: "fixture" }
        : undefined,
  });
  t.after(() => adapter.shutdown());

  const capabilities = await adapter.capabilities(target);
  assert.equal(capabilities.hostManagedModel?.support, "experimental");
  assert.match(capabilities.hostManagedModel?.reason ?? "", /model execution/);
  for (const key of [
    "images",
    "modelSwitch",
    "resumeExecution",
    "viewHistory",
    "detach",
  ] as const) {
    assert.equal(capabilities[key]?.support, "unsupported");
    assert.equal((capabilities[key]?.reason ?? "").length > 0, true);
  }
  const native = await adapter.harnessManagedSupport(target);
  assert.equal(native.support, "unsupported");
  assert.equal((native.reason ?? "").length > 0, true);

  const open = await adapter.hostManagedSupport(target, SELECTION);
  assert.equal(open.support, "experimental");
  assert.equal(open.constraints?.unifiedModelRoute, "experimental");
  const admitted = await adapter.hostManagedSupport(target, {
    ...SELECTION,
    modelId: "with-fixture",
  });
  assert.equal(admitted.support, "supported");
  assert.equal(admitted.constraints?.unifiedModelRoute, "experimental");
  assert.match(admitted.reason ?? "", /Fake Model fixture evidence/);
});

test("fake app-server covers events, isolation, and refuses global Codex config", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-control-"));
  const workspace = join(root, "workspace");
  const globalHome = join(root, "global-codex-home");
  const sentinelConfig = 'model = "personal"\n';
  const sentinelAuth = '{"token":"user-login-token"}\n';
  await mkdir(workspace, { recursive: true });
  await mkdir(globalHome, { recursive: true });
  await writeFile(join(globalHome, "config.toml"), sentinelConfig);
  await writeFile(join(globalHome, "auth.json"), sentinelAuth);
  const executable = join(root, "codex");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const modelCalls: string[] = [];
  const gateway = new FakeGatewayPort();
  const fakes: FakeCodexAppServer[] = [];
  const adapter = new CodexHarnessAdapter({
    root: join(root, "adapter"),
    executablePath: executable,
    targetModelGateway: gateway,
    launchAppServer: async (options) => {
      const fake = new FakeCodexAppServer(`thread-${fakes.length + 1}`, "text");
      fake.bind(options);
      fakes.push(fake);
      return fake;
    },
    isOpenAiResponsesSelection: () => true,
    isSelectionAuthorized: () => true,
    modelFactory: () => fakeModel(modelCalls),
  });
  t.after(async () => {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  });

  const specA = sessionSpec("host-a", workspace);
  const specB = sessionSpec("host-b", workspace);
  const eventsA: AgentEvent[] = [];
  const eventsB: AgentEvent[] = [];
  adapter.subscribe(specA.hostSessionId, (event) => eventsA.push(event));
  adapter.subscribe(specB.hostSessionId, (event) => eventsB.push(event));
  const bindingA = await adapter.create(specA, planFor(specA));
  const bindingB = await adapter.create(specB, planFor(specB));
  assert.notEqual(bindingA.backendSessionId, bindingB.backendSessionId);
  assert.equal(bindingA.hostSessionId, "host-a");
  assert.equal(bindingB.hostSessionId, "host-b");

  await runTextTurn(adapter, specA, "turn-a", "Say hello");
  await runTextTurn(adapter, specB, "turn-b", "Stay isolated");
  assert.deepEqual(
    eventsA.filter((event) => event.kind === "text.delta").map((event) => event.text),
    ["Hel", "lo"],
  );
  const finished = eventsA.filter((event) => event.kind === "message.finished");
  assert.equal(finished.length, 1);
  assert.equal(finished[0]?.kind === "message.finished" ? finished[0].text : "", "Hello");
  assert.deepEqual(
    eventsA
      .filter((event) => event.kind === "usage.reported")
      .map((event) => [event.inputTokens, event.outputTokens]),
    [
      [3, 1],
      [10, 4],
    ],
  );
  assert.equal(
    eventsA.some((event) => event.kind === "tool.started" && event.name === "exec_command"),
    true,
  );
  assert.equal(
    eventsA.some((event) => event.kind === "tool.finished" && event.outcome === "success"),
    true,
  );
  assert.equal(
    eventsA.some((event) => event.kind === "turn.finished" && event.outcome === "success"),
    true,
  );
  assert.deepEqual(modelCalls, []);
  assert.equal(
    fakes[0]?.calls.some((call) => call.method === "initialize"),
    true,
  );
  assert.equal(
    fakes[0]?.calls.some((call) => call.method === "thread/start"),
    true,
  );
  assert.equal(
    fakes[0]?.calls.some((call) => JSON.stringify(call.params).includes("tui")),
    false,
  );

  const configA = await readFile(
    join(codexSessionProfileRoot(join(root, "adapter"), specA), "codex-home", "config.toml"),
    "utf8",
  );
  const configB = await readFile(
    join(codexSessionProfileRoot(join(root, "adapter"), specB), "codex-home", "config.toml"),
    "utf8",
  );
  for (const config of [configA, configB]) {
    assert.match(config, /model_provider = "zcode"/);
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /base_url = "http:\/\/127\.0\.0\.1:9\/v1"/);
    assert.equal(config.includes("user-login-token"), false);
    assert.equal(config.includes("token-host-"), false);
  }
  assert.notEqual(
    codexSessionProfileRoot(join(root, "adapter"), specA),
    codexSessionProfileRoot(join(root, "adapter"), specB),
  );
  assert.equal(await readFile(join(globalHome, "config.toml"), "utf8"), sentinelConfig);
  assert.equal(await readFile(join(globalHome, "auth.json"), "utf8"), sentinelAuth);
  assert.equal(fakes[0]?.env.CODEX_HOME?.includes(globalHome), false);
  assert.equal(fakes[0]?.env.HOME?.includes(globalHome), false);

  await fakes[0]?.pushServerRequest({ id: 7, method: "fs/read", params: {} });
  assert.equal(fakes[0]?.rejections[0]?.code, -32601);
  assert.equal(
    eventsA.some(
      (event) => event.kind === "session.error" && event.code === "unsupported-codex-request",
    ),
    true,
  );

  const revokedBefore = [...gateway.revoked];
  await adapter.terminate(specA.hostSessionId);
  assert.equal(fakes[0]?.terminated, true);
  assert.equal(fakes[1]?.terminated, false);
  assert.deepEqual(gateway.revoked, [...revokedBefore, gateway.grantIdFor("host-a")]);
  await runTextTurn(adapter, specB, "turn-b2", "The other session still runs");
  assert.equal(eventsB.filter((event) => event.kind === "turn.finished").length, 2);
});

test("approval cancel closes the interaction and a late answer cannot continue", async (t) => {
  const { adapter, spec, fake, events } = await openSingle(t, "approval");
  const pending = runTextTurn(adapter, spec, "turn-approval", "Need approval");
  const event = await nextKind(adapter, spec.hostSessionId, "interaction.requested");
  if (event.kind !== "interaction.requested") throw new Error("missing approval");
  await adapter.cancelTurn({
    type: "cancelTurn",
    commandId: "cancel-1",
    hostSessionId: spec.hostSessionId,
    runtimeEpoch: event.runtimeEpoch,
    turnId: event.turnId,
  });
  await pending;
  await assert.rejects(
    () =>
      adapter.resolveInteraction({
        type: "resolveInteraction",
        commandId: "late-1",
        hostSessionId: spec.hostSessionId,
        runtimeEpoch: event.runtimeEpoch,
        turnId: event.turnId,
        interactionId: event.interactionId,
        decision: "allow",
      }),
    /stale Codex approval/,
  );
  assert.equal(fake.responses.length, 0);
  assert.equal(events.filter((item) => item.kind === "turn.started").length, 1);
  assert.equal(
    events.some((item) => item.kind === "turn.finished" && item.outcome === "cancelled"),
    true,
  );
});

test("an in-flight turn rejects a second send without a fake started event", async (t) => {
  const { adapter, spec, events } = await openSingle(t, "approval");
  const pending = runTextTurn(adapter, spec, "turn-live", "Hold the turn");
  await nextKind(adapter, spec.hostSessionId, "interaction.requested");
  await assert.rejects(
    () => runTextTurn(adapter, spec, "turn-second", "Concurrent"),
    /not idle|already executing/,
  );
  assert.equal(events.filter((event) => event.kind === "turn.started").length, 1);
  await adapter.terminate(spec.hostSessionId);
  await pending.catch(() => undefined);
});

test("accepted approval answers only the original JSON-RPC id", async (t) => {
  const { adapter, spec, fake } = await openSingle(t, "approval");
  const pending = runTextTurn(adapter, spec, "turn-allow", "Allow the command");
  const event = await nextKind(adapter, spec.hostSessionId, "interaction.requested");
  if (event.kind !== "interaction.requested") throw new Error("missing approval");
  await adapter.resolveInteraction({
    type: "resolveInteraction",
    commandId: "allow-1",
    hostSessionId: spec.hostSessionId,
    runtimeEpoch: event.runtimeEpoch,
    turnId: event.turnId,
    interactionId: event.interactionId,
    decision: "allow",
  });
  assert.equal(fake.responses.length, 1);
  assert.equal(fake.responses[0]?.id, "approval-1");
  assert.deepEqual(fake.responses[0]?.result, { decision: "accept" });
  fake.finish("completed");
  await pending;
});

test("an unmanaged Codex config is left untouched", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-unmanaged-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const executable = join(root, "codex");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const spec = sessionSpec("host-unmanaged", workspace);
  const configPath = join(
    codexSessionProfileRoot(join(root, "adapter"), spec),
    "codex-home",
    "config.toml",
  );
  await mkdir(join(configPath, ".."), { recursive: true });
  const original = 'model = "personal"\n';
  await writeFile(configPath, original);
  let launched = 0;
  const adapter = new CodexHarnessAdapter({
    root: join(root, "adapter"),
    executablePath: executable,
    targetModelGateway: new FakeGatewayPort(),
    launchAppServer: async () => {
      launched += 1;
      throw new Error("must not launch");
    },
    isOpenAiResponsesSelection: () => true,
    modelFactory: () => fakeModel([]),
  });
  t.after(async () => {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  await assert.rejects(() => adapter.create(spec, planFor(spec)), /unmanaged Codex profile/);
  assert.equal(await readFile(configPath, "utf8"), original);
  assert.equal(launched, 0);
});

class FakeGatewayPort implements TargetModelGatewayPort {
  readonly grantLifetimeMs = 600_000;
  readonly turnLeaseMaxMs = 180_000;
  readonly grants: ModelGatewayGrant[] = [];
  readonly revoked: string[] = [];
  readonly #gateway: ModelGateway;

  constructor() {
    this.#gateway = {
      start: async () => ({ baseUrl: "http://127.0.0.1:9" }),
      createGrant: (input) => {
        const grant: ModelGatewayGrant = {
          id: `grant-${input.sessionId}`,
          token: `token-${input.sessionId}`,
          baseUrl: "http://127.0.0.1:9",
          protocol: input.protocol,
          sessionId: input.sessionId,
          modelBindingFingerprint: input.modelBindingFingerprint,
          actualModel: { providerId: input.model.providerId, modelId: input.model.modelId },
          publicModelId: input.publicModelId,
          expiresAt: Date.now() + input.expiresInMs,
        };
        this.grants.push(grant);
        return grant;
      },
      renewGrant: () => ({ expiresAt: Date.now() + this.grantLifetimeMs }),
      beginTurnLease: () => ({ expiresAt: Date.now() + this.turnLeaseMaxMs }),
      renewTurnLease: () => ({ expiresAt: Date.now() + this.turnLeaseMaxMs }),
      endTurnLease: () => undefined,
      revoke: (grantId) => {
        this.revoked.push(grantId);
      },
      close: async () => undefined,
    };
  }

  get(): ModelGateway {
    return this.#gateway;
  }

  grantIdFor(hostSessionId: string): string {
    return `grant-${hostSessionId}`;
  }

  async close(): Promise<void> {
    await this.#gateway.close();
  }
}

class FakeCodexAppServer {
  readonly calls: { method: string; params: unknown }[] = [];
  readonly responses: { id: JsonRpcId; result: unknown }[] = [];
  readonly rejections: { id: JsonRpcId; code: number; message: string }[] = [];
  env: NodeJS.ProcessEnv = {};
  terminated = false;
  #options?: CodexAppServerProcessOptions;
  #turnId = "";

  constructor(
    readonly threadId: string,
    private readonly script: "text" | "approval",
  ) {}

  bind(options: CodexAppServerProcessOptions): void {
    this.#options = options;
    this.env = options.env;
  }

  async request(method: string, params: unknown): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "initialize") return {};
    if (method === "thread/start" || method === "thread/resume")
      return { thread: { id: this.threadId } };
    if (method === "turn/start") {
      this.#turnId = `${this.threadId}-turn`;
      this.#afterAccepted(() => {
        if (this.script === "text") this.#playText(this.#turnId);
        else this.#requestApproval(this.#turnId);
      });
      return { turn: { id: this.#turnId } };
    }
    if (method === "turn/interrupt") {
      const turnId = this.#turnId;
      this.#afterAccepted(() => this.finish("interrupted", turnId));
      return {};
    }
    return {};
  }

  async notify(method: string, params: unknown): Promise<void> {
    this.calls.push({ method, params });
  }

  async respondToServerRequest(id: JsonRpcId, result: unknown): Promise<void> {
    this.responses.push({ id, result });
  }

  async rejectServerRequest(id: JsonRpcId, code: number, message: string): Promise<void> {
    this.rejections.push({ id, code, message });
  }

  async terminate(): Promise<void> {
    this.terminated = true;
  }

  async pushServerRequest(message: CodexJsonRpcMessage): Promise<void> {
    await this.#options?.onServerRequest(message);
  }

  finish(status: string, turnId = this.#turnId): void {
    this.#options?.onNotification("turn/completed", {
      threadId: this.threadId,
      turn: { id: turnId, status },
    });
  }

  #playText(turnId: string): void {
    const base = { threadId: this.threadId, turnId };
    this.#options?.onNotification("item/agentMessage/delta", {
      ...base,
      itemId: "msg-1",
      delta: "Hel",
    });
    this.#options?.onNotification("item/agentMessage/delta", {
      ...base,
      itemId: "msg-1",
      delta: "lo",
    });
    this.#options?.onNotification("item/completed", {
      ...base,
      item: { type: "agentMessage", id: "msg-1", text: "Hello" },
    });
    this.#options?.onNotification("item/started", {
      ...base,
      item: { type: "commandExecution", id: "cmd-1", command: "echo hi" },
    });
    this.#options?.onNotification("item/completed", {
      ...base,
      item: {
        type: "commandExecution",
        id: "cmd-1",
        command: "echo hi",
        status: "completed",
        exitCode: 0,
        aggregatedOutput: "hi",
      },
    });
    this.#options?.onNotification("thread/tokenUsage/updated", {
      ...base,
      tokenUsage: {
        last: { inputTokens: 3, outputTokens: 1 },
        total: { inputTokens: 100, outputTokens: 80 },
      },
    });
    this.#options?.onNotification("thread/tokenUsage/updated", {
      ...base,
      tokenUsage: {
        last: { inputTokens: 10, outputTokens: 4 },
        total: { inputTokens: 100, outputTokens: 80 },
      },
    });
    this.finish("completed", turnId);
  }

  #requestApproval(turnId: string): void {
    void this.#options?.onServerRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: this.threadId,
        turnId,
        itemId: "cmd-1",
        command: "echo hi",
        reason: "needs approval",
      },
    });
  }

  #afterAccepted(work: () => void): void {
    queueMicrotask(() => {
      queueMicrotask(work);
    });
  }
}

function fakeModel(calls: string[]): Model {
  return {
    providerId: "fake-provider",
    modelId: "fake-model",
    properties: { contextWindow: 16_000 },
    optionSpecs: {},
    options: { reasoningLevel: "off" },
    bind() {
      return this;
    },
    async generateText() {
      calls.push("generate");
      throw new Error("generateText is not the Codex control plane");
    },
    async *streamText() {
      calls.push("stream");
      yield { type: "start" as const, modelId: "fake-model" };
    },
  } as unknown as Model;
}

function sessionSpec(hostSessionId: string, workspace: string): SessionSpec {
  return sessionSpecSchema.parse({
    schemaVersion: 1,
    hostSessionId,
    execution: {
      targetId: "target-1",
      workspaceIdentity: "same-workspace",
      worktreePath: workspace,
    },
    harness: { id: "codex", adapterVersion: "0.157.1" },
    modelBinding: { kind: "host-managed", selection: SELECTION },
  });
}

function planFor(spec: SessionSpec): BindingPlan {
  if (spec.modelBinding.kind !== "host-managed") throw new Error("expected host-managed");
  return bindingPlanSchema.parse({
    schemaVersion: 1,
    hostSessionId: spec.hostSessionId,
    targetId: spec.execution.targetId,
    harnessId: "codex",
    adapterVersion: "0.157.1",
    catalogFingerprint: "catalog-1",
    requested: spec.modelBinding,
    effective: spec.modelBinding.selection,
    route: "responses-gateway",
    support: {
      support: "supported",
      reason: "control-path fixture",
      constraints: {
        compatibilityEvidence: "fake-model-fixture",
        fixtureId: "codex-control-fixture",
        fixtureProviderId: "fake-provider",
        fixtureModelId: "fake-model",
      },
    },
    capabilities: {},
  });
}

async function runTextTurn(
  adapter: CodexHarnessAdapter,
  spec: SessionSpec,
  turnId: string,
  text: string,
): Promise<void> {
  const plan = planFor(spec);
  const prepared = { plan, model: fakeModel([]), turnId };
  await adapter.prepareTurn(spec, prepared);
  await adapter.send(
    { type: "send", commandId: `cmd-${turnId}`, hostSessionId: spec.hostSessionId, turnId, text },
    prepared,
  );
}

function nextKind(
  adapter: CodexHarnessAdapter,
  hostSessionId: string,
  kind: AgentEvent["kind"],
): Promise<AgentEvent> {
  return new Promise((resolve) => {
    const stop = adapter.subscribe(hostSessionId, (event) => {
      if (event.kind !== kind) return;
      stop();
      resolve(event);
    });
  });
}

async function openSingle(
  t: test.TestContext,
  script: "text" | "approval",
): Promise<{
  root: string;
  adapter: CodexHarnessAdapter;
  spec: SessionSpec;
  fake: FakeCodexAppServer;
  events: AgentEvent[];
}> {
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-single-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const executable = join(root, "codex");
  await writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const fake = new FakeCodexAppServer("thread-1", script);
  const adapter = new CodexHarnessAdapter({
    root: join(root, "adapter"),
    executablePath: executable,
    targetModelGateway: new FakeGatewayPort(),
    launchAppServer: async (options) => {
      fake.bind(options);
      return fake;
    },
    isOpenAiResponsesSelection: () => true,
    isSelectionAuthorized: () => true,
    modelFactory: () => fakeModel([]),
  });
  const spec = sessionSpec("host-one", workspace);
  const events: AgentEvent[] = [];
  adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
  await adapter.create(spec, planFor(spec));
  t.after(async () => {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  });
  return { root, adapter, spec, fake, events };
}
