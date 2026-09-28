/**
 * P6 thin knife — OpenCode/Goose ACP opt-in factories through SessionHost (fake transport).
 *
 * Proves same-protocol Agents register via explicit factory + loadExplicit trust list
 * without changing lazy Host defaults or the shared ACP session machine. Goose SessionHost
 * path is symmetric to OpenCode (#75). Late prompt + transport fault/disconnect still journal via SessionHost (OpenCode + Goose). Resume-after-disconnect: SessionHost.open attach via negotiated session/load then send again. Cancel-after-disconnect: after fault fence, cancel of the dead turn is stale; after reopen+session/load, cancel mid-prompt journals cancelled (OpenCode + Goose). Double-fault/reopen: fault→reopen→fault→reopen stays idempotent (session/load, no session/new) then send succeeds (OpenCode + Goose). Mid-tool-call disconnect: tool_call + pending permission then fault → reopen session/load → send (OpenCode + Goose). Permission-denied-then-disconnect: Host denies permission, peer then faults the prompt (OpenCode + Goose). Cancel-during-permission: Host cancelTurn while permission pending journals cancelled (OpenCode + Goose). Permission-resolve-after-reopen: fault mid-permission → reopen → deny still clean (OpenCode + Goose). Allow-after-reopen: fault mid-permission → reopen → fresh allow completes send (OpenCode + Goose). Double-cancel: cancelTurn×2 mid-prompt is idempotent (one cancelled outcome; OpenCode + Goose).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  ACP_ADAPTER_VERSION,
  createExperimentalRegistryGooseAcpHarness,
  createExperimentalRegistryOpenCodeAcpHarness,
  gooseAcpProfile,
  linkAcpTransports,
  openCodeAcpProfile,
  type AcpJsonRpcMessage,
  type AcpTransport,
} from "../src/agent-adapters/acp/index.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { loadExplicitHarnessPlugins } from "../src/agent-host/harnessPluginLoader.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

const here = dirname(fileURLToPath(import.meta.url));
const lazySrc = join(here, "../src/agent-host/lazyTargetService.ts");

interface FakePeerOptions {
  /** Delay before answering session/prompt (late-response path). */
  readonly promptDelayMs?: number;
  /**
   * Mid-prompt transport fault: emit a partial chunk, then JSON-RPC error + close
   * (mirrors ACP transport closed without hanging the Host wait).
   */
  readonly disconnectOnPrompt?: boolean;
  /** Advertise agentCapabilities.loadSession so SessionHost.open → attach can resume. */
  readonly loadSession?: boolean;
  /**
   * Emit a partial chunk, then wait for session/cancel before answering with stopReason cancelled
   * (SessionHost cancelTurn mid-prompt path).
   */
  readonly holdUntilCancel?: boolean;
  /**
   * Mid-tool-call transport fault: emit tool_call + pending session/request_permission,
   * then JSON-RPC error + close (permission left unresolved).
   */
  readonly disconnectOnToolCall?: boolean;
  /**
   * Emit tool_call + await session/request_permission; after Host responds (deny),
   * fault the prompt with JSON-RPC error + close.
   */
  readonly disconnectAfterPermissionDenied?: boolean;
  /**
   * Emit tool_call + await session/request_permission; Host cancelTurn rejects the
   * permission and notifies session/cancel; peer then answers prompt as cancelled.
   */
  readonly cancelDuringPermission?: boolean;
  /**
   * Emit tool_call + await session/request_permission; after Host responds (deny/allow),
   * complete the prompt with end_turn (post-reopen clean resolve path).
   */
  readonly awaitPermissionThenContinue?: boolean;
}

/** Minimal fake ACP peer: initialize / session/new / session/prompt. */
class FakePeer {
  readonly methods: string[] = [];
  readonly #transport: AcpTransport;
  readonly #sessionId: string;
  readonly #agentName: string;
  readonly #options: FakePeerOptions;
  #cancelled = false;
  #cancelWaiters: Array<() => void> = [];
  readonly #pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(transport: AcpTransport, sessionId: string, agentName: string, options: FakePeerOptions = {}) {
    this.#transport = transport;
    this.#sessionId = sessionId;
    this.#agentName = agentName;
    this.#options = options;
    transport.subscribe((message) => {
      void this.#receive(message);
    });
  }

  async #agentRequest(method: string, params: unknown): Promise<unknown> {
    const id = `agent-${this.methods.length}-${this.#pending.size}`;
    const result = new Promise((resolve, reject) => {
      this.#pending.set(String(id), { resolve, reject });
    });
    await this.#transport.send({ jsonrpc: "2.0", id, method, params });
    return result;
  }

  async #receive(message: AcpJsonRpcMessage): Promise<void> {
    if (message.method === undefined && message.id !== undefined && message.id !== null) {
      const pending = this.#pending.get(String(message.id));
      if (!pending) return;
      this.#pending.delete(String(message.id));
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.methods.push(message.method);
    if (message.method === "session/cancel") {
      this.#cancelled = true;
      for (const wake of this.#cancelWaiters) wake();
      this.#cancelWaiters = [];
    }
    if (message.id === undefined || message.id === null) return;
    if (message.method === "initialize") {
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: {
            promptCapabilities: {},
            ...(this.#options.loadSession ? { loadSession: true } : {}),
          },
          authMethods: [],
          agentInfo: { name: this.#agentName, version: "1.0.0" },
        },
      });
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
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { sessionId: this.#sessionId },
      });
      return;
    }
    if (message.method === "session/prompt") {
      const delay = this.#options.promptDelayMs ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (this.#options.holdUntilCancel) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "partial before cancel" },
            },
          },
        });
        if (!this.#cancelled) {
          await new Promise<void>((resolve) => {
            this.#cancelWaiters.push(resolve);
          });
        }
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "cancelled" },
        });
        return;
      }
      if (this.#options.awaitPermissionThenContinue) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-perm-reopen",
              title: "write",
              status: "pending",
            },
          },
        });
        await this.#agentRequest("session/request_permission", {
          sessionId: this.#sessionId,
          toolCall: { toolCallId: "tool-perm-reopen", title: "Write a file?" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        });
        const text = readPrompt(message.params);
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text },
            },
          },
        });
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: "end_turn" },
        });
        return;
      }
      if (this.#options.cancelDuringPermission) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-cancel-perm",
              title: "write",
              status: "pending",
            },
          },
        });
        await this.#agentRequest("session/request_permission", {
          sessionId: this.#sessionId,
          toolCall: { toolCallId: "tool-cancel-perm", title: "Write a file?" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        });
        // cancelTurn notifies session/cancel and rejects the pending permission.
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          result: { stopReason: this.#cancelled ? "cancelled" : "end_turn" },
        });
        return;
      }
      if (this.#options.disconnectAfterPermissionDenied) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-perm-deny",
              title: "write",
              status: "pending",
            },
          },
        });
        const decision = await this.#agentRequest("session/request_permission", {
          sessionId: this.#sessionId,
          toolCall: { toolCallId: "tool-perm-deny", title: "Write a file?" },
          options: [
            { optionId: "allow", kind: "allow_once" },
            { optionId: "reject", kind: "reject_once" },
          ],
        });
        // Host deny must select the reject option before we fault the transport.
        if (!JSON.stringify(decision).includes("reject")) {
          throw new Error("expected Host to deny permission before disconnect");
        }
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      if (this.#options.disconnectOnToolCall) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-mid-disconnect",
              title: "write",
              status: "pending",
            },
          },
        });
        // Fire permission request without awaiting — Host journals interaction.requested, then we fault.
        await this.#transport.send({
          jsonrpc: "2.0",
          id: "agent-perm-mid-disconnect",
          method: "session/request_permission",
          params: {
            sessionId: this.#sessionId,
            toolCall: { toolCallId: "tool-mid-disconnect", title: "Write a file?" },
            options: [
              { optionId: "allow", kind: "allow_once" },
              { optionId: "reject", kind: "reject_once" },
            ],
          },
        });
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      if (this.#options.disconnectOnPrompt) {
        await this.#transport.send({
          jsonrpc: "2.0",
          method: "session/update",
          params: {
            sessionId: this.#sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "partial before disconnect" },
            },
          },
        });
        await this.#transport.send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32000, message: "ACP transport closed" },
        });
        await this.#transport.close();
        return;
      }
      const text = readPrompt(message.params);
      await this.#transport.send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: this.#sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text },
          },
        },
      });
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "end_turn" },
      });
    }
  }
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

function openFakeTransport(
  agentName: string,
  sessionId: string,
  options: FakePeerOptions = {},
  peers?: FakePeer[],
): AcpTransport {
  const link = linkAcpTransports();
  const peer = new FakePeer(link.agent, sessionId, agentName, options);
  peers?.push(peer);
  return link.client;
}

test("lazyTargetService does not register OpenCode or Goose ACP opt-in factories", () => {
  const src = readFileSync(lazySrc, "utf8");
  assert.doesNotMatch(src, /createExperimentalRegistryOpenCodeAcpHarness/);
  assert.doesNotMatch(src, /createExperimentalRegistryGooseAcpHarness/);
  assert.doesNotMatch(src, /openCodeAcpProfile/);
  assert.doesNotMatch(src, /gooseAcpProfile/);
  assert.doesNotMatch(src, /agent-adapters\/acp/);
});

test("opt-in OpenCode ACP factory registers only when caller enables the id", () => {
  const registry = new HarnessRegistry();
  const plugins = [
    {
      manifest: openCodeAcpProfile.manifest,
      trusted: true,
      create: () =>
        createExperimentalRegistryOpenCodeAcpHarness({
          openTransport: () => openFakeTransport("OpenCode", "oc-optin"),
        }),
    },
    {
      manifest: gooseAcpProfile.manifest,
      trusted: true,
      create: () =>
        createExperimentalRegistryGooseAcpHarness({
          openTransport: () => openFakeTransport("Goose", "goose-optin"),
        }),
    },
  ];
  const disabled = loadExplicitHarnessPlugins(registry, plugins, new Set());
  assert.deepEqual(disabled.loaded, []);
  assert.equal(disabled.skipped.length, 2);

  const enabledOpenCode = loadExplicitHarnessPlugins(
    new HarnessRegistry(),
    plugins,
    new Set(["opencode"]),
  );
  assert.deepEqual(enabledOpenCode.loaded, ["opencode"]);
  assert.equal(
    enabledOpenCode.skipped.some((s) => s.id === "goose" && s.reason === "disabled"),
    true,
  );

  const enabledGoose = loadExplicitHarnessPlugins(new HarnessRegistry(), plugins, new Set(["goose"]));
  assert.deepEqual(enabledGoose.loaded, ["goose"]);
  assert.equal(
    enabledGoose.skipped.some((s) => s.id === "opencode" && s.reason === "disabled"),
    true,
  );
});

test("SessionHost + opt-in OpenCode ACP: create/send journals a fake-transport turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-opencode-acp-host-"));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    createExperimentalRegistryOpenCodeAcpHarness({
      openTransport: () => {
        connection += 1;
        return openFakeTransport("OpenCode", `oc-session-${connection}`);
      },
    }),
  );

  const hostSessionId = "opencode-host-1";
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: "workspace-opencode",
      worktreePath: worktree,
    },
    harness: { id: "opencode", adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });
  assert.equal(host.plan.route, "harness-managed");
  assert.equal(host.plan.support.support, "supported");
  assert.equal(host.plan.harnessId, "opencode");
  assert.equal(host.plan.adapterVersion, ACP_ADAPTER_VERSION);
  assert.equal(host.plan.capabilities.hostManagedModel?.support, "unsupported");

  const receipt = await host.dispatch({
    type: "send",
    commandId: "oc-cmd-1",
    hostSessionId,
    turnId: "turn-1",
    text: "hello from SessionHost",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();
  assert.equal(host.queryCommand("oc-cmd-1")?.status, "completed");

  const events = host.eventsSince(0);
  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes("turn.started"));
  assert.ok(kinds.includes("text.delta"));
  assert.ok(kinds.includes("message.finished"));
  assert.ok(kinds.includes("turn.finished"));
  const message = events.find((event) => event.kind === "message.finished");
  assert.ok(message && message.kind === "message.finished");
  assert.equal(message.text, "hello from SessionHost");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "message.finished"));
});

test("SessionHost + opt-in Goose ACP: create/send journals a fake-transport turn (symmetric)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-goose-acp-host-"));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    createExperimentalRegistryGooseAcpHarness({
      openTransport: () => {
        connection += 1;
        return openFakeTransport("Goose", `goose-session-${connection}`);
      },
    }),
  );

  const hostSessionId = "goose-host-1";
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: "workspace-goose",
      worktreePath: worktree,
    },
    harness: { id: "goose", adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });
  assert.equal(host.plan.route, "harness-managed");
  assert.equal(host.plan.support.support, "supported");
  assert.equal(host.plan.harnessId, "goose");
  assert.equal(host.plan.adapterVersion, ACP_ADAPTER_VERSION);
  assert.equal(host.plan.capabilities.hostManagedModel?.support, "unsupported");

  const receipt = await host.dispatch({
    type: "send",
    commandId: "goose-cmd-1",
    hostSessionId,
    turnId: "turn-1",
    text: "hello from Goose SessionHost",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();
  assert.equal(host.queryCommand("goose-cmd-1")?.status, "completed");

  const events = host.eventsSince(0);
  const kinds = events.map((event) => event.kind);
  assert.ok(kinds.includes("turn.started"));
  assert.ok(kinds.includes("text.delta"));
  assert.ok(kinds.includes("message.finished"));
  assert.ok(kinds.includes("turn.finished"));
  const message = events.find((event) => event.kind === "message.finished");
  assert.ok(message && message.kind === "message.finished");
  assert.equal(message.text, "hello from Goose SessionHost");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "message.finished"));
});

test("SessionHost + opt-in OpenCode ACP: late prompt reply still journals the turn", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-opencode-acp-late-"));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    createExperimentalRegistryOpenCodeAcpHarness({
      openTransport: () => {
        connection += 1;
        return openFakeTransport("OpenCode", `oc-late-${connection}`, { promptDelayMs: 40 });
      },
    }),
  );

  const hostSessionId = "opencode-late-1";
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: "workspace-opencode-late",
      worktreePath: worktree,
    },
    harness: { id: "opencode", adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const started = Date.now();
  const receipt = await host.dispatch({
    type: "send",
    commandId: "oc-late-1",
    hostSessionId,
    turnId: "turn-late",
    text: "late reply please",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();
  assert.ok(Date.now() - started >= 35, "expected prompt delay to elapse before idle");
  assert.equal(host.queryCommand("oc-late-1")?.status, "completed");

  const message = host.eventsSince(0).find((event) => event.kind === "message.finished");
  assert.ok(message && message.kind === "message.finished");
  assert.equal(message.text, "late reply please");
  await host.close();
});

test("SessionHost + opt-in Goose ACP: late prompt reply still journals the turn (symmetric)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zcode-goose-acp-late-"));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    createExperimentalRegistryGooseAcpHarness({
      openTransport: () => {
        connection += 1;
        return openFakeTransport("Goose", `goose-late-${connection}`, { promptDelayMs: 40 });
      },
    }),
  );

  const hostSessionId = "goose-late-1";
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: "workspace-goose-late",
      worktreePath: worktree,
    },
    harness: { id: "goose", adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const started = Date.now();
  const receipt = await host.dispatch({
    type: "send",
    commandId: "goose-late-1",
    hostSessionId,
    turnId: "turn-late",
    text: "late reply from Goose",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();
  assert.ok(Date.now() - started >= 35, "expected prompt delay to elapse before idle");
  assert.equal(host.queryCommand("goose-late-1")?.status, "completed");

  const message = host.eventsSince(0).find((event) => event.kind === "message.finished");
  assert.ok(message && message.kind === "message.finished");
  assert.equal(message.text, "late reply from Goose");
  await host.close();
});

async function assertSessionHostTransportDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-disconnect-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  let connection = 0;
  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() => {
      connection += 1;
      return openFakeTransport(input.agentName, `${input.harnessId}-disconnect-${connection}`, {
        disconnectOnPrompt: true,
      });
    }),
  );

  const hostSessionId = `${input.harnessId}-disconnect-1`;
  const commandId = `${input.harnessId}-disconnect-cmd`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-disconnect`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const receipt = await host.dispatch({
    type: "send",
    commandId,
    hostSessionId,
    turnId: "turn-disconnect",
    text: "survive disconnect",
  });
  assert.equal(receipt.status, "accepted");
  await host.whenIdle();

  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "turn.started"));
  assert.ok(
    events.some(
      (event) => event.kind === "text.delta" && event.text === "partial before disconnect",
    ),
  );
  const error = events.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = events.find((event) => event.kind === "turn.finished");
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");

  // Fault fence: Host must not leave the turn unmarked; receipt settles (completed or unknown).
  const settled = host.queryCommand(commandId)?.status;
  assert.ok(settled === "completed" || settled === "execution-unknown", settled);

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(persisted.some((event) => event.kind === "turn.finished"));
}

test("SessionHost + opt-in OpenCode ACP: transport disconnect mid-prompt journals fault fence", async (t) => {
  await assertSessionHostTransportDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: transport disconnect mid-prompt journals fault fence (symmetric)", async (t) => {
  await assertSessionHostTransportDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostResumeAfterDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-rad-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  // Stable backend session id across recreate/open (attach must resume this id).
  const backendSessionId = `${input.harnessId}-rad-session`;
  const peers: FakePeer[] = [];

  const hostSessionId = `${input.harnessId}-rad-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-rad`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Connection 1: negotiate loadSession, disconnect mid-prompt.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectOnPrompt: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-rad-fault`,
    hostSessionId,
    turnId: "turn-rad-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));
  await host.close();

  // Fresh adapter registry simulates Host reopen after transport death (same journal + binding).
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "attach must call session/load after disconnect",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not open a replacement session/new",
  );

  const resumeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-rad-resume`,
    hostSessionId,
    turnId: "turn-rad-resume",
    text: "after resume",
  });
  assert.equal(resumeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "session.error"));
  assert.ok(
    after.some((event) => event.kind === "message.finished" && event.text === "after resume"),
  );
  assert.ok(
    after.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-rad-resume",
    ),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "message.finished" && event.text === "after resume"));
}

test("SessionHost + opt-in OpenCode ACP: resume-after-disconnect via session/load then send", async (t) => {
  await assertSessionHostResumeAfterDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: resume-after-disconnect via session/load then send (symmetric)", async (t) => {
  await assertSessionHostResumeAfterDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostCancelAfterDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-cad-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-cad-session`;
  const hostSessionId = `${input.harnessId}-cad-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-cad`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Connection 1: disconnect mid-prompt → fault fence; cancel of the dead turn is stale.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnPrompt: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-cad-fault`,
    hostSessionId,
    turnId: "turn-cad-fault",
    text: "die mid-prompt",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();
  assert.ok(host.eventsSince(0).some((event) => event.kind === "session.error"));

  const staleCancel = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-cad-stale-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-cad-fault",
  });
  assert.equal(staleCancel.status, "rejected");
  assert.equal(staleCancel.reasonCode, "stale-turn");
  await host.close();

  // Connection 2: reopen + session/load, then cancel mid-prompt journals cancelled.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, holdUntilCancel: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "attach must call session/load after disconnect",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-cad-send`,
    hostSessionId,
    turnId: "turn-cad-live",
    text: "cancel me after resume",
  });
  assert.equal(sendReceipt.status, "accepted");

  // Wait until the peer has emitted the pre-cancel partial (turn is live).
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const partial = resumed.eventsSince(0).some(
      (event) => event.kind === "text.delta" && event.text === "partial before cancel",
    );
    if (partial) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    resumed.eventsSince(0).some(
      (event) => event.kind === "text.delta" && event.text === "partial before cancel",
    ),
    "expected partial before cancel",
  );

  const cancelReceipt = await resumed.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-cad-cancel`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-cad-live",
  });
  assert.equal(cancelReceipt.status, "completed");
  await resumed.whenIdle();

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach the ACP peer after resume",
  );
  const finished = resumed.eventsSince(0).find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-cad-live",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "cancelled");

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-cad-live" &&
        event.outcome === "cancelled",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: cancel-after-disconnect (stale then mid-prompt cancel)", async (t) => {
  await assertSessionHostCancelAfterDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-after-disconnect (stale then mid-prompt cancel, symmetric)", async (t) => {
  await assertSessionHostCancelAfterDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDoubleFaultReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dfr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-dfr-session`;
  const hostSessionId = `${input.harnessId}-dfr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dfr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  async function createHostWithDisconnect(
    peers: FakePeer[],
  ): Promise<SessionHost> {
    const registry = new HarnessRegistry();
    registry.register(
      input.createHarness(() =>
        openFakeTransport(
          input.agentName,
          backendSessionId,
          { loadSession: true, disconnectOnPrompt: true },
          peers,
        ),
      ),
    );
    return SessionHost.create({
      root: journalRoot,
      spec,
      target,
      catalog,
      registry,
    });
  }

  async function openHostWith(
    options: FakePeerOptions,
    peers: FakePeer[],
  ): Promise<SessionHost> {
    const registry = new HarnessRegistry();
    registry.register(
      input.createHarness(() =>
        openFakeTransport(input.agentName, backendSessionId, options, peers),
      ),
    );
    return SessionHost.open({
      root: journalRoot,
      spec,
      target,
      catalog,
      registry,
    });
  }

  // Round 1: fault → close.
  const peers1: FakePeer[] = [];
  const host1 = await createHostWithDisconnect(peers1);
  const fault1 = await host1.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dfr-fault-1`,
    hostSessionId,
    turnId: "turn-dfr-fault-1",
    text: "first fault",
  });
  assert.equal(fault1.status, "accepted");
  await host1.whenIdle();
  assert.ok(host1.eventsSince(0).some((event) => event.kind === "session.error"));
  await host1.close();

  // Round 2: reopen (session/load) → fault again → close.
  const peers2: FakePeer[] = [];
  const host2 = await openHostWith({ loadSession: true, disconnectOnPrompt: true }, peers2);
  assert.ok(
    peers2.some((peer) => peer.methods.includes("session/load")),
    "first reopen must session/load",
  );
  assert.ok(
    peers2.every((peer) => !peer.methods.includes("session/new")),
    "first reopen must not session/new",
  );

  const fault2 = await host2.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dfr-fault-2`,
    hostSessionId,
    turnId: "turn-dfr-fault-2",
    text: "second fault",
  });
  assert.equal(fault2.status, "accepted");
  await host2.whenIdle();
  const afterSecondFault = host2.eventsSince(0);
  const errorsAfterTwo = afterSecondFault.filter((event) => event.kind === "session.error");
  assert.ok(errorsAfterTwo.length >= 2, `expected ≥2 session.error, got ${errorsAfterTwo.length}`);
  assert.ok(
    afterSecondFault.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-dfr-fault-2",
    ),
  );
  await host2.close();

  // Round 3: second reopen stays idempotent (session/load again), then healthy send.
  const peers3: FakePeer[] = [];
  const host3 = await openHostWith({ loadSession: true }, peers3);
  assert.ok(
    peers3.some((peer) => peer.methods.includes("session/load")),
    "second reopen must session/load (idempotent)",
  );
  assert.ok(
    peers3.every((peer) => !peer.methods.includes("session/new")),
    "second reopen must not session/new",
  );

  const ok = await host3.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dfr-ok`,
    hostSessionId,
    turnId: "turn-dfr-ok",
    text: "after double fault",
  });
  assert.equal(ok.status, "accepted");
  await host3.whenIdle();

  const finalEvents = host3.eventsSince(0);
  assert.ok(
    finalEvents.some(
      (event) => event.kind === "message.finished" && event.text === "after double fault",
    ),
  );
  assert.ok(
    finalEvents.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-dfr-ok",
    ),
  );

  await host3.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.filter((event) => event.kind === "session.error").length >= 2,
    "journal must keep both fault fences",
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after double fault",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: double-fault reopen idempotency then send", async (t) => {
  await assertSessionHostDoubleFaultReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: double-fault reopen idempotency then send (symmetric)", async (t) => {
  await assertSessionHostDoubleFaultReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostMidToolDisconnectResume(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-mtd-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-mtd-session`;
  const hostSessionId = `${input.harnessId}-mtd-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-mtd`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const peersFault: FakePeer[] = [];
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, disconnectOnToolCall: true },
        peersFault,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-mtd-fault`,
    hostSessionId,
    turnId: "turn-mtd-fault",
    text: "tool then die",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(
    faultEvents.some((event) => event.kind === "tool.started"),
    "expected tool.started before disconnect",
  );
  assert.ok(
    faultEvents.some((event) => event.kind === "interaction.requested"),
    "expected interaction.requested before disconnect",
  );
  const error = faultEvents.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  assert.ok(
    faultEvents.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-mtd-fault",
    ),
  );
  await host.close();

  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, { loadSession: true }, peersAfter),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen after mid-tool disconnect must session/load",
  );
  assert.ok(
    peersAfter.every((peer) => !peer.methods.includes("session/new")),
    "resume must not session/new",
  );

  const resumeReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-mtd-resume`,
    hostSessionId,
    turnId: "turn-mtd-resume",
    text: "after mid-tool resume",
  });
  assert.equal(resumeReceipt.status, "accepted");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(after.some((event) => event.kind === "session.error"));
  assert.ok(
    after.some(
      (event) => event.kind === "message.finished" && event.text === "after mid-tool resume",
    ),
  );
  assert.ok(
    after.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-mtd-resume",
    ),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "tool.started"));
  assert.ok(persisted.some((event) => event.kind === "interaction.requested"));
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "after mid-tool resume",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: mid-tool-call disconnect then reopen resume", async (t) => {
  await assertSessionHostMidToolDisconnectResume({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: mid-tool-call disconnect then reopen resume (symmetric)", async (t) => {
  await assertSessionHostMidToolDisconnectResume({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostPermissionDeniedThenDisconnect(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-pdd-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const hostSessionId = `${input.harnessId}-pdd-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-pdd`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, `${input.harnessId}-pdd-session`, {
        disconnectAfterPermissionDenied: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-pdd-send`,
    hostSessionId,
    turnId: "turn-pdd",
    text: "deny then die",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = host.eventsSince(0).find((event) => event.kind === "interaction.requested");
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected interaction.requested before deny");

  const denyReceipt = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-pdd-deny`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-pdd",
    interactionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");

  await host.whenIdle();

  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "tool.started"));
  assert.ok(
    events.some(
      (event) => event.kind === "interaction.resolved" && event.decision === "deny",
    ),
  );
  const error = events.find((event) => event.kind === "session.error");
  assert.ok(error && error.kind === "session.error");
  assert.match(error.message, /ACP transport closed/);
  const finished = events.find((event) => event.kind === "turn.finished");
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "unknown");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) => event.kind === "interaction.resolved" && event.decision === "deny",
    ),
  );
  assert.ok(persisted.some((event) => event.kind === "session.error"));
}

test("SessionHost + opt-in OpenCode ACP: permission-denied-then-disconnect journals deny + fault", async (t) => {
  await assertSessionHostPermissionDeniedThenDisconnect({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: permission-denied-then-disconnect journals deny + fault (symmetric)", async (t) => {
  await assertSessionHostPermissionDeniedThenDisconnect({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostCancelDuringPermission(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-cdp-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const peers: FakePeer[] = [];
  const hostSessionId = `${input.harnessId}-cdp-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-cdp`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        `${input.harnessId}-cdp-session`,
        { cancelDuringPermission: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-cdp-send`,
    hostSessionId,
    turnId: "turn-cdp",
    text: "cancel while permission pending",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (host.eventsSince(0).some((event) => event.kind === "interaction.requested")) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    host.eventsSince(0).some((event) => event.kind === "interaction.requested"),
    "expected interaction.requested before cancel",
  );

  const cancelReceipt = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-cdp-cancel`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-cdp",
  });
  assert.equal(cancelReceipt.status, "completed");
  await host.whenIdle();

  assert.ok(
    peers.some((peer) => peer.methods.includes("session/cancel")),
    "cancel must reach ACP peer during pending permission",
  );
  const events = host.eventsSince(0);
  assert.ok(events.some((event) => event.kind === "tool.started"));
  assert.ok(events.some((event) => event.kind === "interaction.requested"));
  const finished = events.find(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-cdp",
  );
  assert.ok(finished && finished.kind === "turn.finished");
  assert.equal(finished.outcome, "cancelled");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "turn.finished" &&
        event.turnId === "turn-cdp" &&
        event.outcome === "cancelled",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: cancel-during-permission journals cancelled", async (t) => {
  await assertSessionHostCancelDuringPermission({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: cancel-during-permission journals cancelled (symmetric)", async (t) => {
  await assertSessionHostCancelDuringPermission({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostPermissionResolveAfterReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-prr-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-prr-session`;
  const hostSessionId = `${input.harnessId}-prr-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-prr`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: fault mid-permission (unresolved), then close.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnToolCall: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-prr-fault`,
    hostSessionId,
    turnId: "turn-prr-fault",
    text: "die mid-permission",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  assert.ok(faultEvents.some((event) => event.kind === "session.error"));
  // Stale resolve against the dead turn must be rejected (no hang / no crash).
  const stale = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-prr-stale`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-prr-fault",
    interactionId: "acp-permission:tool-mid-disconnect",
    decision: "deny",
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reasonCode, "stale-interaction");
  await host.close();

  // Round 2: reopen + session/load; fresh permission deny completes cleanly.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, awaitPermissionThenContinue: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must session/load after mid-permission fault",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-prr-send`,
    hostSessionId,
    turnId: "turn-prr-live",
    text: "deny after reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = resumed.eventsSince(0).find(
      (event) =>
        event.kind === "interaction.requested" && event.turnId === "turn-prr-live",
    );
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected fresh interaction.requested after reopen");

  const denyReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-prr-deny`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-prr-live",
    interactionId,
    decision: "deny",
  });
  assert.equal(denyReceipt.status, "completed");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(
    after.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-prr-live" &&
        event.decision === "deny",
    ),
  );
  assert.ok(
    after.some(
      (event) => event.kind === "message.finished" && event.text === "deny after reopen",
    ),
  );
  assert.ok(
    after.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-prr-live",
    ),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-prr-live" &&
        event.decision === "deny",
    ),
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "deny after reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: permission-resolve-after-reopen deny is clean", async (t) => {
  await assertSessionHostPermissionResolveAfterReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: permission-resolve-after-reopen deny is clean (symmetric)", async (t) => {
  await assertSessionHostPermissionResolveAfterReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostAllowAfterReopen(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-aar-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-aar-session`;
  const hostSessionId = `${input.harnessId}-aar-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-aar`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  // Round 1: fault mid-permission (unresolved), then close.
  const registryLive = new HarnessRegistry();
  registryLive.register(
    input.createHarness(() =>
      openFakeTransport(input.agentName, backendSessionId, {
        loadSession: true,
        disconnectOnToolCall: true,
      }),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryLive,
  });

  const faultReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-aar-fault`,
    hostSessionId,
    turnId: "turn-aar-fault",
    text: "die mid-permission",
  });
  assert.equal(faultReceipt.status, "accepted");
  await host.whenIdle();

  const faultEvents = host.eventsSince(0);
  assert.ok(faultEvents.some((event) => event.kind === "interaction.requested"));
  assert.ok(faultEvents.some((event) => event.kind === "session.error"));
  // Stale resolve against the dead turn must be rejected (no hang / no crash).
  const stale = await host.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-aar-stale`,
    hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch!,
    turnId: "turn-aar-fault",
    interactionId: "acp-permission:tool-mid-disconnect",
    decision: "allow",
  });
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reasonCode, "stale-interaction");
  await host.close();

  // Round 2: reopen + session/load; fresh permission allow completes send.
  const peersAfter: FakePeer[] = [];
  const registryReopen = new HarnessRegistry();
  registryReopen.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { loadSession: true, awaitPermissionThenContinue: true },
        peersAfter,
      ),
    ),
  );

  const resumed = await SessionHost.open({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry: registryReopen,
  });

  assert.ok(
    peersAfter.some((peer) => peer.methods.includes("session/load")),
    "reopen must session/load after mid-permission fault",
  );

  const sendReceipt = await resumed.dispatch({
    type: "send",
    commandId: `${input.harnessId}-aar-send`,
    hostSessionId,
    turnId: "turn-aar-live",
    text: "allow after reopen",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  let interactionId: string | undefined;
  while (Date.now() < deadline) {
    const requested = resumed.eventsSince(0).find(
      (event) =>
        event.kind === "interaction.requested" && event.turnId === "turn-aar-live",
    );
    if (requested && requested.kind === "interaction.requested") {
      interactionId = requested.interactionId;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(interactionId, "expected fresh interaction.requested after reopen");

  const allowReceipt = await resumed.dispatch({
    type: "resolveInteraction",
    commandId: `${input.harnessId}-aar-allow`,
    hostSessionId,
    runtimeEpoch: resumed.binding.runtimeEpoch!,
    turnId: "turn-aar-live",
    interactionId,
    decision: "allow",
  });
  assert.equal(allowReceipt.status, "completed");
  await resumed.whenIdle();

  const after = resumed.eventsSince(0);
  assert.ok(
    after.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-aar-live" &&
        event.decision === "allow",
    ),
  );
  assert.ok(
    after.some(
      (event) => event.kind === "message.finished" && event.text === "allow after reopen",
    ),
  );
  assert.ok(
    after.some(
      (event) => event.kind === "turn.finished" && event.turnId === "turn-aar-live",
    ),
  );

  await resumed.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  assert.ok(persisted.some((event) => event.kind === "session.error"));
  assert.ok(
    persisted.some(
      (event) =>
        event.kind === "interaction.resolved" &&
        event.turnId === "turn-aar-live" &&
        event.decision === "allow",
    ),
  );
  assert.ok(
    persisted.some(
      (event) => event.kind === "message.finished" && event.text === "allow after reopen",
    ),
  );
}

test("SessionHost + opt-in OpenCode ACP: allow-after-reopen succeeds send", async (t) => {
  await assertSessionHostAllowAfterReopen({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: allow-after-reopen succeeds send (symmetric)", async (t) => {
  await assertSessionHostAllowAfterReopen({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});

async function assertSessionHostDoubleCancel(input: {
  t: { after: (fn: () => void | Promise<void>) => void };
  label: string;
  harnessId: "opencode" | "goose";
  agentName: string;
  createHarness: (openTransport: () => AcpTransport) => ReturnType<
    typeof createExperimentalRegistryOpenCodeAcpHarness
  >;
}): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `zcode-${input.label}-acp-dc-`));
  const worktree = join(root, "worktree");
  const journalRoot = join(root, "journal");
  await mkdir(worktree, { recursive: true });
  input.t.after(() => rm(root, { recursive: true, force: true }));

  const backendSessionId = `${input.harnessId}-dc-session`;
  const hostSessionId = `${input.harnessId}-dc-1`;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "local",
      workspaceIdentity: `workspace-${input.harnessId}-dc`,
      worktreePath: worktree,
    },
    harness: { id: input.harnessId, adapterVersion: ACP_ADAPTER_VERSION },
    modelBinding: { kind: "harness-managed" as const },
  };
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const catalog = {
    fingerprint: "registry-v1",
    validateSelection: () => ({ ok: true as const }),
  };

  const peers: FakePeer[] = [];
  const registry = new HarnessRegistry();
  registry.register(
    input.createHarness(() =>
      openFakeTransport(
        input.agentName,
        backendSessionId,
        { holdUntilCancel: true },
        peers,
      ),
    ),
  );

  const host = await SessionHost.create({
    root: journalRoot,
    spec,
    target,
    catalog,
    registry,
  });

  const sendReceipt = await host.dispatch({
    type: "send",
    commandId: `${input.harnessId}-dc-send`,
    hostSessionId,
    turnId: "turn-dc-1",
    text: "cancel me twice",
  });
  assert.equal(sendReceipt.status, "accepted");

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      host.eventsSince(0).some(
        (event) => event.kind === "text.delta" && event.text === "partial before cancel",
      )
    ) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(
    host.eventsSince(0).some(
      (event) => event.kind === "text.delta" && event.text === "partial before cancel",
    ),
    "expected partial before cancel",
  );

  const epoch = host.binding.runtimeEpoch!;
  const first = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dc-cancel-1`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-dc-1",
  });
  assert.equal(first.status, "completed");

  // Second cancel while/after the first: must not hang or crash.
  // Idempotent notify (completed) or already-finished (stale-turn) are both safe.
  const second = await host.dispatch({
    type: "cancelTurn",
    commandId: `${input.harnessId}-dc-cancel-2`,
    hostSessionId,
    runtimeEpoch: epoch,
    turnId: "turn-dc-1",
  });
  assert.ok(
    second.status === "completed" ||
      (second.status === "rejected" && second.reasonCode === "stale-turn"),
    `second cancel must be idempotent-safe, got ${second.status}/${second.reasonCode}`,
  );

  await host.whenIdle();

  assert.ok(
    peers.some((peer) => peer.methods.includes("session/cancel")),
    "at least one session/cancel must reach the peer",
  );

  const finished = host
    .eventsSince(0)
    .filter((event) => event.kind === "turn.finished" && event.turnId === "turn-dc-1");
  assert.equal(finished.length, 1, "exactly one turn.finished for the cancelled turn");
  assert.equal(finished[0]!.kind, "turn.finished");
  assert.equal(finished[0]!.outcome, "cancelled");

  await host.close();
  const persisted = await SessionHost.eventsSinceHistory(journalRoot, spec, 0);
  const persistedFinished = persisted.filter(
    (event) => event.kind === "turn.finished" && event.turnId === "turn-dc-1",
  );
  assert.equal(persistedFinished.length, 1);
  assert.equal(persistedFinished[0]!.kind, "turn.finished");
  assert.equal(persistedFinished[0]!.outcome, "cancelled");
}

test("SessionHost + opt-in OpenCode ACP: double-cancel is idempotent", async (t) => {
  await assertSessionHostDoubleCancel({
    t,
    label: "opencode",
    harnessId: "opencode",
    agentName: "OpenCode",
    createHarness: (openTransport) =>
      createExperimentalRegistryOpenCodeAcpHarness({ openTransport }),
  });
});

test("SessionHost + opt-in Goose ACP: double-cancel is idempotent (symmetric)", async (t) => {
  await assertSessionHostDoubleCancel({
    t,
    label: "goose",
    harnessId: "goose",
    agentName: "Goose",
    createHarness: (openTransport) =>
      createExperimentalRegistryGooseAcpHarness({ openTransport }),
  });
});
