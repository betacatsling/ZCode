import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACP_ADAPTER_VERSION,
  ACP_SESSION_MACHINE_ID,
  buildAcpCompatibilityReport,
  createAcpHarness,
  diagnoseAcpInstall,
  gooseAcpProfile,
  linkAcpTransports,
  negotiateAcpInitialize,
  openCodeAcpProfile,
  type AcpJsonRpcMessage,
  type AcpTransport,
} from "../src/agent-adapters/acp/index.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { loadExplicitHarnessPlugins } from "../src/agent-host/harnessPluginLoader.js";
import type { AgentEvent, BindingPlan, ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";

const target: ExecutionTarget = {
  id: "local-1",
  kind: "local",
  platform: "linux",
  available: true,
};

interface FakeOptions {
  protocolVersion?: number;
  loadSession?: boolean;
  resume?: boolean;
  images?: boolean;
  authMethods?: readonly { methodId: string; type?: string }[];
  agentName?: string;
  onPrompt?: (text: string, peer: FakePeer) => Promise<void>;
  onLoad?: (peer: FakePeer) => Promise<void>;
}

class FakePeer {
  readonly methods: string[] = [];
  cancelled = false;
  #transport: AcpTransport;
  #options: FakeOptions;
  #sessionId: string;

  constructor(transport: AcpTransport, options: FakeOptions, sessionId: string) {
    this.#transport = transport;
    this.#options = options;
    this.#sessionId = sessionId;
    transport.subscribe((message) => {
      void this.#receive(message);
    });
  }

  sessionId(): string {
    return this.#sessionId;
  }

  async notify(method: string, params: unknown): Promise<void> {
    await this.#transport.send({ jsonrpc: "2.0", method, params });
  }

  async request(method: string, params: unknown): Promise<unknown> {
    const id = `agent-${this.methods.length}`;
    const result = new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    await this.#transport.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  readonly #pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  async #receive(message: AcpJsonRpcMessage): Promise<void> {
    if (message.method === undefined && message.id !== undefined && message.id !== null) {
      const key = String(message.id);
      const pending = this.#pending.get(key);
      if (!pending) return;
      this.#pending.delete(key);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (!message.method) return;
    this.methods.push(message.method);
    if (message.method === "session/cancel") {
      this.cancelled = true;
      return;
    }
    if (message.id === undefined || message.id === null) return;
    if (message.method === "initialize") {
      await this.#transport.send({ jsonrpc: "2.0", id: message.id, result: initializeResult(this.#options) });
      return;
    }
    if (message.method === "session/new") {
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: this.#sessionId },
      });
      return;
    }
    if (message.method === "session/load" || message.method === "session/resume") {
      await this.#options.onLoad?.(this);
      await this.#transport.send({ jsonrpc: "2.0", id: message.id, result: { sessionId: this.#sessionId } });
      return;
    }
    if (message.method === "session/prompt") {
      const text = readPrompt(message.params);
      if (this.#options.onPrompt) await this.#options.onPrompt(text, this);
      else await this.chunk(text);
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: this.cancelled ? "cancelled" : "end_turn" },
      });
    }
  }

  async chunk(text: string, sourceEventId?: string): Promise<void> {
    await this.notify("session/update", {
      sessionId: this.#sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        ...(sourceEventId ? { id: sourceEventId } : {}),
        content: { type: "text", text },
      },
    });
  }
}

function initializeResult(options: FakeOptions): Record<string, unknown> {
  const version = options.protocolVersion ?? 1;
  const authMethods = options.authMethods ?? [];
  if (version === 1) {
    return {
      protocolVersion: 1,
      agentCapabilities: {
        ...(options.loadSession ? { loadSession: true } : {}),
        promptCapabilities: { image: options.images === true },
        sessionCapabilities: options.resume ? { resume: {} } : {},
      },
      authMethods,
      agentInfo: { name: options.agentName ?? "fake-acp", version: "1.2.3" },
    };
  }
  return {
    protocolVersion: version,
    info: { name: options.agentName ?? "fake-acp", version: "2.0.0" },
    capabilities: version === 2 ? { session: { prompt: options.images ? { image: {} } : {} } } : {},
    authMethods,
    agentCapabilities: { loadSession: true },
  };
}

function readPrompt(params: unknown): string {
  if (!params || typeof params !== "object") return "";
  const prompt = (params as { prompt?: unknown }).prompt;
  if (!Array.isArray(prompt)) return "";
  const first = prompt[0];
  if (!first || typeof first !== "object") return "";
  const text = (first as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

function specFor(hostSessionId: string, harnessId: string): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: {
      targetId: target.id,
      workspaceIdentity: "workspace-identity",
      worktreePath: "/tmp/acp-workspace",
    },
    harness: { id: harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" },
  };
}

function planFor(hostSessionId: string, harnessId: string): BindingPlan {
  return {
    schemaVersion: 1,
    hostSessionId,
    targetId: target.id,
    harnessId,
    adapterVersion: ACP_ADAPTER_VERSION,
    catalogFingerprint: "catalog-test",
    requested: { kind: "harness-managed" },
    route: "harness-managed",
    support: { support: "supported" },
    capabilities: {},
  };
}

function harness(profile: typeof openCodeAcpProfile, options: FakeOptions = {}) {
  const peers: FakePeer[] = [];
  const adapter = createAcpHarness({
    profile,
    openTransport: () => {
      const link = linkAcpTransports();
      peers.push(new FakePeer(link.agent, options, options.agentName ?? `${profile.manifest.id}-session`));
      return link.client;
    },
  });
  return { adapter, peers };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("timed out waiting for ACP event");
}

function textOf(events: readonly AgentEvent[]): string {
  return events
    .flatMap((event) => (event.kind === "text.delta" ? [event.text] : []))
    .join("");
}

test("version 1 negotiates load and resume only from the initialize payload", () => {
  const hidden = negotiateAcpInitialize({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: {} },
    agentInfo: { name: "OpenCode", version: "1.0.0" },
  });
  assert.equal(hidden.stability, "stable");
  assert.equal(hidden.loadSession, false);
  assert.equal(hidden.resumeSession, false);
  const advertised = negotiateAcpInitialize({
    protocolVersion: 1,
    agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } },
  });
  assert.equal(advertised.loadSession, true);
  assert.equal(advertised.resumeSession, true);
});

test("a changed or unknown protocol version is experimental and drops advertised resume", () => {
  const v2 = negotiateAcpInitialize({
    protocolVersion: 2,
    capabilities: { session: {} },
    agentCapabilities: { loadSession: true },
  });
  assert.equal(v2.stability, "experimental");
  assert.equal(v2.loadSession, false);
  const unknown = negotiateAcpInitialize({
    protocolVersion: 9,
    agentCapabilities: { loadSession: true },
  });
  assert.equal(unknown.loadSession, false);
  assert.equal(unknown.resumeSession, false);
  assert.match(unknown.stabilityReason ?? "", /not a stable contract/);
});

test("OpenCode without negotiated resume can show history and does not pretend to continue", async () => {
  const { adapter, peers } = harness(openCodeAcpProfile, { agentName: "OpenCode" });
  const spec = specFor("host-opencode", "opencode");
  await adapter.create(spec, planFor(spec.hostSessionId, "opencode"));
  const events: AgentEvent[] = [];
  adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
  await adapter.send({
    type: "send",
    commandId: "cmd-1",
    hostSessionId: spec.hostSessionId,
    turnId: "turn-1",
    text: "hello",
  });
  assert.equal(textOf(adapter.viewHistory(spec.hostSessionId)), "hello");
  assert.equal(events.some((event) => event.kind === "message.finished" && event.text === "hello"), true);
  const before = peers[0]?.methods.length ?? 0;
  await assert.rejects(
    adapter.resumeExecution(spec.hostSessionId, peers[0]?.sessionId() ?? "missing"),
    /unsupported: ACP session resume was not negotiated/,
  );
  const extra = peers[0]?.methods.slice(before) ?? [];
  assert.deepEqual(extra, []);
  assert.equal(adapter.viewHistory(spec.hostSessionId).at(-1)?.kind, "turn.finished");
});

test("attach without negotiated resume does not open a replacement session", async () => {
  const { adapter } = harness(openCodeAcpProfile);
  const spec = specFor("host-attach", "opencode");
  const binding = await adapter.create(spec, planFor(spec.hostSessionId, "opencode"));
  await adapter.terminate(spec.hostSessionId);
  const { adapter: reattached, peers } = harness(openCodeAcpProfile);
  await assert.rejects(
    reattached.attach(spec, binding, 3, planFor(spec.hostSessionId, "opencode")),
    /unsupported: ACP session resume was not negotiated/,
  );
  assert.equal(peers.some((peer) => peer.methods.includes("session/new")), false);
  assert.equal(peers.some((peer) => peer.methods.includes("session/load")), false);
  assert.equal(peers.some((peer) => peer.methods.includes("session/prompt")), false);
});

test("negotiated session/load resumes without copying replay into host text", async () => {
  const { adapter, peers } = harness(openCodeAcpProfile, {
    loadSession: true,
    onLoad: async (peer) => {
      await peer.chunk("old history");
    },
  });
  const spec = specFor("host-load", "opencode");
  const binding = await adapter.create(spec, planFor(spec.hostSessionId, "opencode"));
  await adapter.terminate(spec.hostSessionId);
  const resumed = harness(openCodeAcpProfile, {
    loadSession: true,
    onLoad: async (peer) => {
      await peer.chunk("replayed");
    },
  });
  await resumed.adapter.attach(spec, binding, 4, planFor(spec.hostSessionId, "opencode"));
  assert.equal(resumed.peers[0]?.methods.includes("session/load"), true);
  assert.equal(resumed.peers[0]?.methods.includes("session/prompt"), false);
  assert.equal(textOf(resumed.adapter.viewHistory(spec.hostSessionId)), "");
  assert.equal(
    resumed.adapter.viewHistory(spec.hostSessionId).some((event) => event.kind === "extension.event"),
    true,
  );
  assert.equal(peers.length > 0, true);
});

test("negotiated session/resume does not claim history replay", async () => {
  const { adapter } = harness(gooseAcpProfile, { resume: true, agentName: "Goose" });
  const spec = specFor("host-goose", "goose");
  const binding = await adapter.create(spec, planFor(spec.hostSessionId, "goose"));
  const result = await adapter.resumeExecution(spec.hostSessionId, binding.backendSessionId);
  assert.deepEqual(result, { method: "session/resume", replaysHistory: false });
});

test("Goose and OpenCode share one session machine and register without a brand branch", async () => {
  const machine = await readFile(
    new URL("../src/agent-adapters/acp/acpSessionMachine.ts", import.meta.url),
    "utf8",
  );
  const goose = await readFile(new URL("../src/agent-adapters/acp/agents/goose.ts", import.meta.url), "utf8");
  const opencode = await readFile(
    new URL("../src/agent-adapters/acp/agents/opencode.ts", import.meta.url),
    "utf8",
  );
  assert.equal(machine.includes("opencode"), false);
  assert.equal(machine.includes("goose"), false);
  assert.equal(goose.includes("session/load"), false);
  assert.equal(opencode.includes("session/load"), false);
  const registry = new HarnessRegistry();
  const loaded = loadExplicitHarnessPlugins(
    registry,
    [openCodeAcpProfile, gooseAcpProfile].map((profile) => ({
      manifest: profile.manifest,
      trusted: true,
      create: () => createAcpHarness({ profile, openTransport: () => linkAcpTransports().client }),
    })),
    new Set(["opencode", "goose"]),
  );
  assert.deepEqual(loaded.loaded, ["opencode", "goose"]);
  assert.equal(registry.require("opencode").sessionMachineId, ACP_SESSION_MACHINE_ID);
  assert.equal(registry.require("goose").sessionMachineId, ACP_SESSION_MACHINE_ID);
});

test("protocol version 2 stays experimental and does not start a session", async () => {
  const { adapter, peers } = harness(openCodeAcpProfile, { protocolVersion: 2, loadSession: true });
  const report = await adapter.probe(target);
  assert.equal(report.support, "experimental");
  const capabilities = await adapter.capabilities(target);
  assert.equal(capabilities.resumeExecution.support, "experimental");
  assert.equal(capabilities.viewHistory?.support, "supported");
  await assert.rejects(
    adapter.create(specFor("host-v2", "opencode"), planFor("host-v2", "opencode")),
    /experimental/,
  );
  assert.equal(peers.some((peer) => peer.methods.includes("session/new")), false);
});

test("unknown extensions and client filesystem methods are refused", async () => {
  const { adapter, peers } = harness(openCodeAcpProfile, {
    onPrompt: async (_text, peer) => {
      await peer.notify("session/update", {
        sessionId: peer.sessionId(),
        update: { sessionUpdate: "widget_inject", script: "alert(1)" },
      });
      const extension = await peer.request("_acp/exec", { command: "rm -rf /" }).catch((error: unknown) => error);
      assert.match(extension instanceof Error ? extension.message : "", /unsupported ACP extension/);
      const filesystem = await peer
        .request("fs/read_text_file", { path: "/tmp/secret" })
        .catch((error: unknown) => error);
      assert.match(filesystem instanceof Error ? filesystem.message : "", /unsupported ACP extension/);
      await peer.chunk("visible");
    },
  });
  const spec = specFor("host-ext", "opencode");
  await adapter.create(spec, planFor(spec.hostSessionId, "opencode"));
  await adapter.send({
    type: "send",
    commandId: "cmd-ext",
    hostSessionId: spec.hostSessionId,
    turnId: "turn-ext",
    text: "go",
  });
  const history = adapter.viewHistory(spec.hostSessionId);
  const extension = history.find((event) => event.kind === "extension.event");
  assert.equal(extension?.kind === "extension.event" ? extension.namespace : "", "acp.update");
  assert.equal(textOf(history), "visible");
  assert.equal(JSON.stringify(history).includes("rm -rf"), false);
  assert.equal(JSON.stringify(history).includes("/tmp/secret"), false);
  assert.equal(peers[0]?.methods.includes("_acp/exec"), false);
});

test("partial tool JSON is not submitted and permission denial does not allow the tool", async () => {
  const { adapter } = harness(openCodeAcpProfile, {
    onPrompt: async (_text, peer) => {
      await peer.notify("session/update", {
        sessionId: peer.sessionId(),
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "write",
          status: "pending",
          rawInput: "{",
        },
      });
      const decision = await peer.request("session/request_permission", {
        sessionId: peer.sessionId(),
        toolCall: { toolCallId: "tool-1", title: "Write a file?" },
        options: [
          { optionId: "allow", kind: "allow_once" },
          { optionId: "reject", kind: "reject_once" },
        ],
      });
      assert.equal(JSON.stringify(decision).includes("reject"), true);
      await peer.notify("session/update", {
        sessionId: peer.sessionId(),
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          status: "completed",
          rawInput: { path: "a.ts" },
        },
      });
    },
  });
  const spec = specFor("host-tool", "opencode");
  const events: AgentEvent[] = [];
  adapter.subscribe(spec.hostSessionId, (event) => {
    events.push(event);
    if (event.kind === "interaction.requested") {
      void adapter.resolveInteraction({
        type: "resolveInteraction",
        commandId: "cmd-decision",
        hostSessionId: spec.hostSessionId,
        runtimeEpoch: event.runtimeEpoch,
        turnId: event.turnId,
        interactionId: event.interactionId,
        decision: "deny",
      });
    }
  });
  await adapter.create(spec, planFor(spec.hostSessionId, "opencode"));
  await adapter.send({
    type: "send",
    commandId: "cmd-tool",
    hostSessionId: spec.hostSessionId,
    turnId: "turn-tool",
    text: "edit",
  });
  const started = events.find((event) => event.kind === "tool.started");
  assert.equal(started?.kind === "tool.started" ? started.inputText : "missing", undefined);
  assert.equal(JSON.stringify(events).includes('"{'), false);
  assert.equal(
    events.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
    true,
  );
});

test("cancel only reaches the current turn", async () => {
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { adapter, peers } = harness(openCodeAcpProfile, {
    onPrompt: async (_text, peer) => {
      await peer.chunk("partial");
      await gate;
    },
  });
  const spec = specFor("host-cancel", "opencode");
  const binding = await adapter.create(spec, planFor(spec.hostSessionId, "opencode"));
  const sending = adapter.send({
    type: "send",
    commandId: "cmd-cancel",
    hostSessionId: spec.hostSessionId,
    turnId: "turn-live",
    text: "run",
  });
  await waitFor(() => textOf(adapter.viewHistory(spec.hostSessionId)).includes("partial"));
  await assert.rejects(
    adapter.cancelTurn({
      type: "cancelTurn",
      commandId: "cmd-stale",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: binding.runtimeEpoch,
      turnId: "turn-other",
    }),
    /stale-turn/,
  );
  assert.equal(peers[0]?.methods.includes("session/cancel"), false);
  await adapter.cancelTurn({
    type: "cancelTurn",
    commandId: "cmd-live",
    hostSessionId: spec.hostSessionId,
    runtimeEpoch: binding.runtimeEpoch,
    turnId: "turn-live",
  });
  release?.();
  await sending;
  assert.equal(peers[0]?.methods.filter((method) => method === "session/cancel").length, 1);
  assert.equal(
    adapter.viewHistory(spec.hostSessionId).some((event) => event.kind === "turn.finished" && event.outcome === "cancelled"),
    true,
  );
});

test("duplicate source updates and a burst of chunks keep one contiguous transcript", async () => {
  const { adapter } = harness(openCodeAcpProfile, {
    onPrompt: async (_text, peer) => {
      await peer.chunk("A", "chunk-a");
      await peer.chunk("B", "chunk-a");
      for (let index = 0; index < 200; index += 1) await peer.chunk("x", `chunk-${index}`);
    },
  });
  const spec = specFor("host-burst", "opencode");
  await adapter.create(spec, planFor(spec.hostSessionId, "opencode"));
  await adapter.send({
    type: "send",
    commandId: "cmd-burst",
    hostSessionId: spec.hostSessionId,
    turnId: "turn-burst",
    text: "burst",
  });
  const deltas = adapter.viewHistory(spec.hostSessionId).filter((event) => event.kind === "text.delta");
  assert.equal(deltas.length, 201);
  assert.equal(textOf(adapter.viewHistory(spec.hostSessionId)), `A${"x".repeat(200)}`);
  const sequences = adapter.viewHistory(spec.hostSessionId).map((event) => event.sequence);
  assert.deepEqual(
    sequences,
    sequences.map((_value, index) => index + 1),
  );
});

test("advertised auth is reported without submitting credentials", async () => {
  const { adapter, peers } = harness(openCodeAcpProfile, {
    authMethods: [{ methodId: "terminal-login", type: "terminal" }],
  });
  const report = await adapter.probe(target);
  assert.equal(report.support, "unsupported");
  assert.match(report.reason ?? "", /terminal-login/);
  assert.equal(JSON.stringify(report).includes("token"), false);
  assert.equal(peers.some((peer) => peer.methods.includes("authenticate")), false);
  assert.equal(peers.some((peer) => peer.methods.includes("auth/login")), false);
  const compatibility = buildAcpCompatibilityReport({
    profile: openCodeAcpProfile,
    install: diagnoseAcpInstall({ profile: openCodeAcpProfile, executableFound: false }),
    negotiation: negotiateAcpInitialize({
      protocolVersion: 1,
      authMethods: [{ methodId: "terminal-login", secret: "do-not-keep" }],
    }),
  });
  assert.deepEqual(compatibility.authMethodIds, ["terminal-login"]);
  assert.equal(JSON.stringify(compatibility).includes("do-not-keep"), false);
  assert.equal(compatibility.install.support, "unsupported");
});

test("two host sessions on one ACP harness stay independent", async () => {
  const { adapter } = harness(openCodeAcpProfile);
  const first = specFor("host-a", "opencode");
  const second = specFor("host-b", "opencode");
  await adapter.create(first, planFor(first.hostSessionId, "opencode"));
  await adapter.create(second, planFor(second.hostSessionId, "opencode"));
  await adapter.send({
    type: "send",
    commandId: "cmd-a",
    hostSessionId: first.hostSessionId,
    turnId: "turn-a",
    text: "alpha",
  });
  assert.equal(textOf(adapter.viewHistory(first.hostSessionId)), "alpha");
  assert.equal(textOf(adapter.viewHistory(second.hostSessionId)), "");
});

test("ndjson framing accepts split chunks and rejects malformed lines", async () => {
  const { pushAcpNdjson } = await import("../src/agent-adapters/acp/acpTransport.js");
  const messages: AcpJsonRpcMessage[] = [];
  const invalid: string[] = [];
  const parser = pushAcpNdjson(
    (message) => messages.push(message),
    (line) => invalid.push(line),
  );
  parser.push('{"jsonrpc":"2.0","method":"session/up');
  parser.push('date"}\nnot-json\n{"jsonrpc":"2.0","method":"session/cancel"}\n');
  assert.deepEqual(
    messages.map((message) => message.method),
    ["session/update", "session/cancel"],
  );
  assert.deepEqual(invalid, ["not-json"]);
});
