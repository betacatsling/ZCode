import assert from "node:assert/strict";
import test from "node:test";
import type { AgentEvent, ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";
import { agentEventSchema } from "@zcode/shared/agent-host";
import { piControlPlaneCapabilities } from "./piCapabilities.js";
import { PiAdapter } from "./piAdapter.js";
import {
  createLinkedPiTurnTransport,
  type PiHostFrame,
  type PiPeerFrame,
  type PiTurnTransport,
} from "./piTurnTransport.js";
import type { PiModelBindingPlannerPort, PiModelHint } from "./piModelBindingBridge.js";

const target: ExecutionTarget = {
  id: "local-1",
  kind: "local",
  platform: "linux",
  available: true,
};

function spec(
  hostSessionId: string,
  kind: SessionSpec["modelBinding"]["kind"] = "host-managed",
): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: {
      targetId: "local-1",
      workspaceIdentity: "workspace-same",
      worktreePath: "/tmp/same-worktree",
    },
    harness: { id: "pi", adapterVersion: "0.87.1" },
    modelBinding:
      kind === "host-managed"
        ? {
            kind: "host-managed",
            selection: {
              providerId: "provider-a",
              modelId: "model-a",
              options: { reasoningLevel: "off" },
            },
          }
        : { kind: "harness-managed", nativeModelId: "pi-native" },
  };
}

function catalog(ref = "ref.provider-api-key.provider-a") {
  return {
    fingerprint: "catalog-1",
    validateSelection: () => ({ ok: true as const }),
    credentialRef: () => ref,
    credentialSource: () => "provider-api-key" as const,
  };
}

/** 测试替身，不是第二套规划器。只复述 PR #3 已定的接受/拒绝形状。 */
function planner(options?: {
  mismatch?: boolean;
  echoSecret?: boolean;
}): PiModelBindingPlannerPort {
  return {
    async plan(input) {
      const secret = JSON.stringify(input.startupOverrides ?? {});
      if (/apiKey|baseUrl|sk-|https?:\/\//i.test(secret)) {
        return rejected(
          input,
          "writing a provider URL or key into CLI configuration is not a host-managed binding",
        );
      }
      if (input.spec.modelBinding.kind === "harness-managed") {
        return {
          kind: "harness-managed",
          unifiedModelRouting: false,
          hostManagedCertification: "not-applicable",
          route: "harness-managed",
          requested: input.spec.modelBinding,
          support: { support: "supported" },
          capabilities: {
            tools: { support: "supported" },
            images: { support: "unsupported", reason: "not certified" },
            reasoning: { support: "unknown", reason: "harness owns the model" },
            resume: { support: "unsupported", reason: "not certified" },
            modelSwitch: { support: "unsupported", reason: "next turn only" },
            backgroundCalls: { support: "unknown", reason: "not certified" },
          },
          startupOverrides: {
            applied: false,
            credentialInjection: "refused",
            reason: "provider URL and key stay in the model service",
          },
          catalogFingerprint: input.catalog.fingerprint,
          versionFingerprint: "fp-harness",
          execution: { kind: "harness-managed" },
        };
      }
      const selection = input.spec.modelBinding.selection;
      if (
        options?.mismatch ||
        (input.executor &&
          (input.executor.providerId !== selection.providerId ||
            input.executor.modelId !== selection.modelId))
      ) {
        return rejected(input, "existing model executor route does not match the requested model");
      }
      return {
        kind: "host-managed",
        unifiedModelRouting: true,
        hostManagedCertification: "incomplete",
        route: "pi-sdk",
        requested: input.spec.modelBinding,
        effective: selection,
        support: { support: "supported" },
        capabilities: {
          tools: { support: "supported" },
          images: {
            support: "unsupported",
            reason: "images are not in the first Pi control slice",
          },
          reasoning: { support: "supported" },
          resume: { support: "unsupported", reason: "resume is not certified" },
          modelSwitch: { support: "unsupported", reason: "model switch applies on the next turn" },
          backgroundCalls: { support: "unknown", reason: "background calls are not certified" },
        },
        credentialRef: options?.echoSecret
          ? "sk-live-secret"
          : input.catalog.credentialRef?.(selection),
        credentialSource: "provider-api-key",
        startupOverrides: {
          applied: false,
          credentialInjection: "refused",
          reason: "provider URL and key stay in the model service",
        },
        catalogFingerprint: input.catalog.fingerprint,
        versionFingerprint: "fp-host-1",
        execution: { kind: "existing-model-runtime" },
      };
    },
  };
}

function rejected(
  input: { spec: SessionSpec; catalog: { fingerprint: string } },
  reason: string,
): Awaited<ReturnType<PiModelBindingPlannerPort["plan"]>> {
  return {
    kind: input.spec.modelBinding.kind,
    unifiedModelRouting: false,
    hostManagedCertification:
      input.spec.modelBinding.kind === "harness-managed" ? "not-applicable" : "incomplete",
    requested: input.spec.modelBinding,
    support: { support: "unsupported", reason },
    capabilities: {
      tools: { support: "unknown", reason },
      images: { support: "unknown", reason },
      reasoning: { support: "unknown", reason },
      resume: { support: "unknown", reason },
      modelSwitch: { support: "unknown", reason },
      backgroundCalls: { support: "unknown", reason },
    },
    startupOverrides: {
      applied: false,
      credentialInjection: "refused",
      reason: "provider URL and key stay in the model service",
    },
    catalogFingerprint: input.catalog.fingerprint,
    versionFingerprint: "fp-rejected",
    execution: { kind: "unbound" },
  };
}

class ScriptedPiPeer {
  readonly executed: string[] = [];
  #decisions = new Map<string, (decision: "allow" | "deny") => void>();
  #cancelled = new Set<string>();
  #terminated = false;

  constructor(readonly transport: PiTurnTransport) {
    transport.subscribe((frame) => {
      const host = frame as PiHostFrame;
      if (host.type === "session.open") {
        void transport.send({
          type: "session.ready",
          backendSessionId: `pi-${host.hostSessionId}`,
        } satisfies PiPeerFrame);
      } else if (host.type === "turn.prompt") {
        void this.#run(host);
      } else if (host.type === "approval.decision") {
        this.#decisions.get(host.interactionId)?.(host.decision);
      } else if (host.type === "turn.cancel") {
        this.#cancelled.add(host.turnId);
        for (const settle of this.#decisions.values()) settle("deny");
      } else if (host.type === "session.terminate") {
        this.#terminated = true;
        for (const settle of this.#decisions.values()) settle("deny");
      }
    });
  }

  async #run(frame: Extract<PiHostFrame, { type: "turn.prompt" }>): Promise<void> {
    const tool = toolFor(frame.text);
    await this.transport.send({
      type: "text.delta",
      turnId: frame.turnId,
      messageId: "m1",
      text: "hello ",
      sourceEventId: `${frame.turnId}:d1`,
    });
    await this.transport.send({
      type: "text.delta",
      turnId: frame.turnId,
      messageId: "m1",
      text: "world",
      sourceEventId: `${frame.turnId}:d1`,
    });
    await this.transport.send({
      type: "message.snapshot",
      turnId: frame.turnId,
      messageId: "m1",
      role: "assistant",
      text: "hello world",
      sourceEventId: `${frame.turnId}:snap`,
    });
    if (!tool) {
      await this.#finish(frame.turnId, "success");
      return;
    }
    const interactionId = `${frame.turnId}:${tool.name}`;
    const decision = new Promise<"allow" | "deny">((resolve) => {
      this.#decisions.set(interactionId, resolve);
    });
    await this.transport.send({
      type: "tool.pending",
      turnId: frame.turnId,
      toolCallId: interactionId,
      name: tool.name,
      summary: tool.summary,
      sourceEventId: `${interactionId}:pending`,
    });
    const choice = await decision;
    this.#decisions.delete(interactionId);
    if (choice !== "allow" || this.#cancelled.has(frame.turnId) || this.#terminated) {
      await this.#finish(
        frame.turnId,
        this.#cancelled.has(frame.turnId) || this.#terminated ? "cancelled" : "success",
      );
      return;
    }
    this.executed.push(tool.name);
    await this.transport.send({
      type: "tool.result",
      turnId: frame.turnId,
      toolCallId: interactionId,
      name: tool.name,
      outcome: "success",
      outputText: tool.name === "read" ? "file-body" : "ok",
      ...(tool.name === "write" ? { file: { path: "README.md", additions: 2, deletions: 0 } } : {}),
      sourceEventId: `${interactionId}:result`,
    });
    await this.#finish(frame.turnId, "success");
  }

  async #finish(turnId: string, outcome: "success" | "cancelled" | "failed"): Promise<void> {
    await this.transport.send({
      type: "usage",
      turnId,
      inputTokens: 3,
      outputTokens: 4,
      sourceEventId: `${turnId}:usage`,
    });
    await this.transport.send({
      type: "turn.done",
      turnId,
      outcome,
      sourceEventId: `${turnId}:done`,
    });
  }
}

function toolFor(
  text: string,
): { name: "read" | "write" | "exec" | "browser"; summary: string } | undefined {
  if (text.startsWith("read ")) return { name: "read", summary: "Read README.md" };
  if (text.startsWith("write ")) return { name: "write", summary: "Write README.md" };
  if (text.startsWith("run ")) return { name: "exec", summary: "Run tests" };
  if (text.startsWith("browse ")) return { name: "browser", summary: "Open a page" };
  return undefined;
}

function harness(options?: {
  planner?: PiModelBindingPlannerPort;
  peers?: Map<string, ScriptedPiPeer>;
  sent?: PiHostFrame[];
}) {
  const peers = options?.peers ?? new Map<string, ScriptedPiPeer>();
  const sent = options?.sent ?? [];
  let tick = 0;
  const adapter = new PiAdapter({
    planner: options?.planner ?? planner(),
    now: () => 1_700_000_000_000,
    ids: () => `id-${tick++}`,
    transportFactory: (session) => {
      const linked = createLinkedPiTurnTransport();
      peers.set(session.hostSessionId, new ScriptedPiPeer(linked.peer));
      return {
        async send(frame) {
          sent.push(frame as PiHostFrame);
          await linked.host.send(frame);
        },
        subscribe: (listener) => linked.host.subscribe(listener),
        close: () => linked.host.close(),
      };
    },
  });
  return { adapter, peers, sent };
}

function bind(session: SessionSpec, executor = { providerId: "provider-a", modelId: "model-a" }) {
  return { spec: session, target, catalog: catalog(), executor };
}

async function open(adapter: PiAdapter, session: SessionSpec) {
  return adapter.open(session);
}

test("same workspace keeps two Pi sessions and cancel stays on one turn", async () => {
  const { adapter, peers, sent } = harness();
  const first = spec("host-a");
  const second = spec("host-b");
  const bindingA = await open(adapter, first);
  const bindingB = await open(adapter, second);
  assert.equal(first.execution.workspaceIdentity, second.execution.workspaceIdentity);
  assert.notEqual(bindingA.hostSessionId, bindingB.hostSessionId);
  assert.notEqual(bindingA.backendSessionId, bindingB.backendSessionId);
  assert.notEqual(bindingA.runtimeEpoch, bindingB.runtimeEpoch);
  const eventsA: AgentEvent[] = [];
  adapter.subscribe("host-a", (event) => eventsA.push(event));
  const running = adapter.dispatch(
    {
      type: "send",
      commandId: "send-a",
      hostSessionId: "host-a",
      turnId: "turn-a",
      text: "write README",
    },
    bind(first),
  );
  await waitFor(eventsA, "interaction.requested");
  const stale = await adapter.dispatch({
    type: "cancelTurn",
    commandId: "cancel-stale",
    hostSessionId: "host-a",
    runtimeEpoch: bindingA.runtimeEpoch,
    turnId: "turn-other",
  });
  assert.equal(stale.receipt.status, "rejected");
  assert.equal(stale.receipt.reasonCode, "stale-turn");
  assert.equal(sent.filter((frame) => frame.type === "turn.cancel").length, 0);
  const cancelled = await adapter.dispatch({
    type: "cancelTurn",
    commandId: "cancel-a",
    hostSessionId: "host-a",
    runtimeEpoch: bindingA.runtimeEpoch,
    turnId: "turn-a",
  });
  assert.equal(cancelled.receipt.status, "completed");
  await running;
  assert.equal(peers.get("host-a")?.executed.length, 0);
  assert.equal(
    eventsA.some((event) => event.kind === "tool.started"),
    false,
  );
  assert.equal(
    eventsA.some((event) => event.kind === "tool.finished"),
    false,
  );
  assert.equal(
    eventsA.some((event) => event.kind === "turn.finished" && event.outcome === "cancelled"),
    true,
  );
  const eventsB: AgentEvent[] = [];
  adapter.subscribe("host-b", (event) => eventsB.push(event));
  const other = adapter.dispatch(
    {
      type: "send",
      commandId: "send-b",
      hostSessionId: "host-b",
      turnId: "turn-b",
      text: "say hello",
    },
    bind(second),
  );
  await other;
  assert.equal(
    eventsB.some((event) => event.kind === "turn.finished" && event.outcome === "success"),
    true,
  );
  assert.equal(
    eventsA.some((event) => "turnId" in event && event.turnId === "turn-b"),
    false,
  );
});

test("approval blocks file write and exec until allow, and denial has no side effect", async () => {
  const { adapter, peers } = harness();
  const session = spec("host-write");
  const binding = await open(adapter, session);
  const events: AgentEvent[] = [];
  adapter.subscribe("host-write", (event) => events.push(event));
  const denied = adapter.dispatch(
    {
      type: "send",
      commandId: "send-deny",
      hostSessionId: "host-write",
      turnId: "turn-deny",
      text: "write README",
    },
    bind(session),
  );
  await waitForTurn(events, "interaction.requested", "turn-deny");
  const deny = await adapter.dispatch({
    type: "resolveInteraction",
    commandId: "deny-1",
    hostSessionId: "host-write",
    runtimeEpoch: binding.runtimeEpoch,
    turnId: "turn-deny",
    interactionId: "turn-deny:write",
    decision: "deny",
  });
  assert.equal(deny.receipt.status, "completed");
  await denied;
  assert.deepEqual(peers.get("host-write")?.executed, []);
  assert.equal(
    events.some((event) => event.kind === "file.changed"),
    false,
  );
  assert.equal(
    events.some((event) => event.kind === "tool.started"),
    false,
  );

  const allowed = adapter.dispatch(
    {
      type: "send",
      commandId: "send-allow",
      hostSessionId: "host-write",
      turnId: "turn-allow",
      text: "write README",
    },
    bind(session),
  );
  await waitForTurn(events, "interaction.requested", "turn-allow");
  await adapter.dispatch({
    type: "resolveInteraction",
    commandId: "allow-1",
    hostSessionId: "host-write",
    runtimeEpoch: binding.runtimeEpoch,
    turnId: "turn-allow",
    interactionId: "turn-allow:write",
    decision: "allow",
  });
  await allowed;
  assert.deepEqual(peers.get("host-write")?.executed, ["write"]);
  assert.equal(
    events.some(
      (event) =>
        event.kind === "file.changed" && event.path === "README.md" && event.additions === 2,
    ),
    true,
  );

  const exec = adapter.dispatch(
    {
      type: "send",
      commandId: "send-exec",
      hostSessionId: "host-write",
      turnId: "turn-exec",
      text: "run tests",
    },
    bind(session),
  );
  await waitForTurn(events, "interaction.requested", "turn-exec");
  await adapter.dispatch({
    type: "resolveInteraction",
    commandId: "allow-exec",
    hostSessionId: "host-write",
    runtimeEpoch: binding.runtimeEpoch,
    turnId: "turn-exec",
    interactionId: "turn-exec:exec",
    decision: "allow",
  });
  await exec;
  assert.deepEqual(peers.get("host-write")?.executed, ["write", "exec"]);
});

test("read and text publish canonical events; history does not send another prompt", async () => {
  const { adapter, peers, sent } = harness();
  const session = spec("host-read");
  const binding = await open(adapter, session);
  const events: AgentEvent[] = [];
  adapter.subscribe("host-read", (event) => events.push(event));
  const turn = adapter.dispatch(
    {
      type: "send",
      commandId: "send-read",
      hostSessionId: "host-read",
      turnId: "turn-read",
      text: "read README",
    },
    bind(session),
  );
  await waitForTurn(events, "interaction.requested", "turn-read");
  await adapter.dispatch({
    type: "resolveInteraction",
    commandId: "allow-read",
    hostSessionId: "host-read",
    runtimeEpoch: binding.runtimeEpoch,
    turnId: "turn-read",
    interactionId: "turn-read:read",
    decision: "allow",
  });
  await turn;
  for (const event of events) agentEventSchema.parse(event);
  const deltas = events.filter((event) => event.kind === "text.delta");
  assert.deepEqual(
    deltas.map((event) => (event.kind === "text.delta" ? event.text : "")),
    ["hello "],
  );
  const finished = events.find((event) => event.kind === "message.finished");
  assert.equal(
    finished && finished.kind === "message.finished" ? finished.text : "",
    "hello world",
  );
  assert.equal(
    events.some((event) => event.kind === "tool.finished" && event.outputText === "file-body"),
    true,
  );
  assert.equal(peers.get("host-read")?.executed.includes("read"), true);
  const prompts = sent.filter((frame) => frame.type === "turn.prompt").length;
  const history = await adapter.dispatch({
    type: "viewHistory",
    commandId: "hist-1",
    hostSessionId: "host-read",
  });
  assert.equal(history.receipt.status, "completed");
  assert.equal(history.events?.length, events.length);
  assert.equal(sent.filter((frame) => frame.type === "turn.prompt").length, prompts);
  const sequences = (history.events ?? []).map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    sequences.map((_, index) => index + 1),
  );
});

test("duplicate commands, stale approvals, detach, and unsupported resume do not change execution", async () => {
  const { adapter, sent } = harness();
  const session = spec("host-edge");
  const binding = await open(adapter, session);
  const events: AgentEvent[] = [];
  adapter.subscribe("host-edge", (event) => events.push(event));
  const first = adapter.dispatch(
    {
      type: "send",
      commandId: "send-1",
      hostSessionId: "host-edge",
      turnId: "turn-1",
      text: "write README",
    },
    bind(session),
  );
  await waitFor(events, "interaction.requested");
  const duplicate = await adapter.dispatch(
    {
      type: "send",
      commandId: "send-1",
      hostSessionId: "host-edge",
      turnId: "turn-1",
      text: "write README",
    },
    bind(session),
  );
  assert.equal(duplicate.receipt.status, "duplicate");
  const wrongEpoch = await adapter.dispatch({
    type: "resolveInteraction",
    commandId: "wrong-epoch",
    hostSessionId: "host-edge",
    runtimeEpoch: "other-epoch",
    turnId: "turn-1",
    interactionId: "turn-1:write",
    decision: "allow",
  });
  assert.equal(wrongEpoch.receipt.reasonCode, "stale-epoch");
  assert.equal(sent.filter((frame) => frame.type === "approval.decision").length, 0);
  const detached = await adapter.dispatch({
    type: "detach",
    commandId: "detach-1",
    hostSessionId: "host-edge",
  });
  assert.equal(detached.receipt.status, "completed");
  const before = events.length;
  await adapter.dispatch({
    type: "resolveInteraction",
    commandId: "allow-after-detach",
    hostSessionId: "host-edge",
    runtimeEpoch: binding.runtimeEpoch,
    turnId: "turn-1",
    interactionId: "turn-1:write",
    decision: "allow",
  });
  await first;
  assert.equal(events.length, before);
  const history = await adapter.dispatch({
    type: "viewHistory",
    commandId: "hist-edge",
    hostSessionId: "host-edge",
  });
  assert.equal(
    history.events?.some((event) => event.kind === "tool.finished"),
    true,
  );
  const resume = await adapter.dispatch({
    type: "resumeExecution",
    commandId: "resume-1",
    hostSessionId: "host-edge",
    runtimeEpoch: binding.runtimeEpoch,
  });
  assert.equal(resume.receipt.status, "rejected");
  assert.equal(resume.receipt.reasonCode, "unsupported");
  const browserEvents: AgentEvent[] = [];
  adapter.subscribe("host-edge", (event) => browserEvents.push(event));
  const browser = adapter.dispatch(
    {
      type: "send",
      commandId: "send-browser",
      hostSessionId: "host-edge",
      turnId: "turn-browser",
      text: "browse docs",
    },
    bind(session),
  );
  await browser;
  assert.equal(
    browserEvents.some((event) => event.kind === "tool.started"),
    false,
  );
  assert.equal(
    browserEvents.some((event) => event.kind === "session.error" && event.code === "unsupported"),
    true,
  );
});

test("host-managed prompts record the planner route and never carry a provider URL or key", async () => {
  const sent: PiHostFrame[] = [];
  const { adapter } = harness({
    sent,
    planner: planner(),
  });
  const session = spec("host-model");
  await open(adapter, session);
  const turn = adapter.dispatch(
    {
      type: "send",
      commandId: "send-model",
      hostSessionId: "host-model",
      turnId: "turn-model",
      text: "say hello",
    },
    {
      ...bind(session),
      startupOverrides: { apiKey: "sk-live-secret", baseUrl: "https://provider.example/v1" },
    },
  );
  const result = await turn;
  assert.equal(result.receipt.status, "rejected");
  assert.equal(result.receipt.reasonCode, "invalid-binding");
  assert.equal(JSON.stringify(result).includes("sk-live-secret"), false);
  assert.equal(JSON.stringify(result).includes("https://provider.example"), false);
  assert.equal(
    sent.some((frame) => frame.type === "turn.prompt"),
    false,
  );

  const accepted = await adapter.dispatch(
    {
      type: "send",
      commandId: "send-ok",
      hostSessionId: "host-model",
      turnId: "turn-ok",
      text: "say hello",
    },
    bind(session),
  );
  assert.equal(accepted.receipt.status, "completed");
  const prompt = sent.find((frame) => frame.type === "turn.prompt");
  assert.ok(prompt && prompt.type === "turn.prompt");
  const hint: PiModelHint = prompt.model;
  assert.equal(hint.kind, "host-managed");
  if (hint.kind === "host-managed") {
    assert.equal(hint.route, "pi-sdk");
    assert.equal(hint.providerId, "provider-a");
    assert.equal(hint.modelId, "model-a");
    assert.equal(hint.credentialRef, "ref.provider-api-key.provider-a");
  }
  assert.equal(JSON.stringify(hint).includes("sk-"), false);
  assert.equal(JSON.stringify(hint).includes("http"), false);
  const routes = adapter.modelRoutes("host-model");
  assert.equal(routes.at(-1)?.unifiedModelRouting, true);
  assert.equal(routes.at(-1)?.effectiveProviderId, "provider-a");
  assert.equal(routes.at(-1)?.effectiveModelId, "model-a");
  assert.equal(routes.at(-1)?.versionFingerprint, "fp-host-1");
  assert.equal(routes[0]?.accepted, false);
});

test("harness-managed does not claim unified routing, and a secret credential ref is dropped", async () => {
  const sent: PiHostFrame[] = [];
  const { adapter } = harness({ sent, planner: planner({ echoSecret: true }) });
  const native = spec("host-native", "harness-managed");
  await open(adapter, native);
  const managed = await adapter.dispatch(
    {
      type: "send",
      commandId: "send-native",
      hostSessionId: "host-native",
      turnId: "turn-native",
      text: "say hello",
    },
    { spec: native, target, catalog: catalog() },
  );
  assert.equal(managed.receipt.status, "completed");
  const prompt = sent.find((frame) => frame.type === "turn.prompt");
  assert.ok(prompt && prompt.type === "turn.prompt");
  assert.equal(prompt.model.kind, "harness-managed");
  assert.equal(adapter.modelRoutes("host-native").at(-1)?.unifiedModelRouting, false);
  assert.equal(JSON.stringify(prompt.model).includes("provider-a"), false);

  const secretSent: PiHostFrame[] = [];
  const secretAdapter = harness({
    sent: secretSent,
    planner: planner({ echoSecret: true }),
  }).adapter;
  const host = spec("host-secret");
  await open(secretAdapter, host);
  const rejected = await secretAdapter.dispatch(
    {
      type: "send",
      commandId: "send-secret",
      hostSessionId: "host-secret",
      turnId: "turn-secret",
      text: "say hello",
    },
    bind(host),
  );
  assert.equal(rejected.receipt.status, "rejected");
  assert.equal(JSON.stringify(rejected).includes("sk-live-secret"), false);
  assert.equal(
    secretSent.some((frame) => frame.type === "turn.prompt"),
    false,
  );
});

test("capabilities name the unsupported slice instead of pretending it works", async () => {
  const { adapter } = harness();
  const report = await adapter.capabilities(target);
  assert.deepEqual(report, piControlPlaneCapabilities(adapter.hostManagedRoute));
  for (const field of ["text", "tools", "approvals", "cancelTurn", "history"] as const) {
    assert.equal(report[field].support, "supported", field);
    assert.match(report[field].reason ?? "", /.+/, field);
  }
  assert.deepEqual(report.tools.constraints, { read: true, write: true, exec: true });
  assert.match(report.tools.reason ?? "", /read/);
  assert.match(report.tools.reason ?? "", /write/);
  assert.match(report.tools.reason ?? "", /exec/);
  assert.doesNotMatch(report.tools.reason ?? "", /bash/);
  for (const field of ["resumeExecution", "images", "modelSwitch"] as const) {
    assert.equal(report[field].support, "unsupported", field);
    assert.equal(report[field].reason, report.resumeExecution.reason);
    for (const named of ["resumeExecution", "images", "modelSwitch"] as const) {
      assert.match(report[field].reason ?? "", new RegExp(named), field);
    }
    assert.match(report[field].reason ?? "", /does not upgrade/);
  }
  assert.match(report.resumeExecution.reason ?? "", /viewHistory/);
  assert.match(report.modelSwitch.reason ?? "", /later turn/);
  assert.equal(report.detach?.support, "supported");
  assert.match(report.detach?.reason ?? "", /detach/);
  assert.match(report.detach?.reason ?? "", /does not close/);
  assert.equal(report.terminateSession?.support, "supported");
  assert.match(report.terminateSession?.reason ?? "", /terminateSession/);
  assert.equal(report.viewHistory?.support, "supported");
  assert.match(report.viewHistory?.reason ?? "", /viewHistory/);
  assert.match(report.viewHistory?.reason ?? "", /does not send a new prompt/);
  assert.equal(report.hostManagedModel?.support, "experimental");
  assert.match(report.hostManagedModel?.reason ?? "", /does not call Model\.streamText/);
  assert.match(report.hostManagedModel?.reason ?? "", /resumeExecution/);
  assert.equal(report.hostManagedModel?.constraints?.route, adapter.hostManagedRoute);
  const probed = await adapter.probe(target);
  assert.equal(probed.support, "supported");
  assert.match(probed.reason ?? "", /does not certify/);
  assert.notEqual(report.resumeExecution.support, probed.support);
  assert.notEqual(report.images.support, probed.support);
  assert.notEqual(report.modelSwitch.support, probed.support);
  assert.notEqual(report.hostManagedModel?.support, probed.support);
  const modelSupport = await adapter.hostManagedSupport(target, {
    providerId: "provider-a",
    modelId: "model-a",
    options: { reasoningLevel: "off" },
  });
  assert.equal(modelSupport.support, "experimental");
  assert.equal(modelSupport.constraints?.execution, "not-this-adapter");
  assert.equal(modelSupport.constraints?.route, adapter.hostManagedRoute);
  assert.match(modelSupport.reason ?? "", /does not certify/);
  assert.notEqual(report.resumeExecution.support, modelSupport.support);
  const ssh = await adapter.probe({ ...target, kind: "ssh", id: "ssh-1" });
  assert.equal(ssh.support, "unsupported");
  assert.deepEqual(await adapter.capabilities(target), report);
});

test(
  "live Pi process and provider credentials",
  { skip: "未运行：没有真实 Pi 进程或模型凭据" },
  () => {
    assert.fail("live Pi must not run in this job");
  },
);

async function waitFor(events: readonly AgentEvent[], kind: AgentEvent["kind"]): Promise<void> {
  await waitForTurn(events, kind);
}

async function waitForTurn(
  events: readonly AgentEvent[],
  kind: AgentEvent["kind"],
  turnId?: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (
      events.some(
        (event) =>
          event.kind === kind &&
          (turnId === undefined || ("turnId" in event && event.turnId === turnId)),
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(`missing ${kind}`);
}
