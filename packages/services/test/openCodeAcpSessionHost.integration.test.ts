/**
 * P6 thin knife — OpenCode/Goose ACP opt-in factories through SessionHost (fake transport).
 *
 * Proves same-protocol Agents register via explicit factory + loadExplicit trust list
 * without changing lazy Host defaults or the shared ACP session machine. Goose SessionHost
 * path is symmetric to OpenCode (#75). Late prompt + transport fault/disconnect still journal via SessionHost (OpenCode + Goose).
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
}

/** Minimal fake ACP peer: initialize / session/new / session/prompt. */
class FakePeer {
  readonly methods: string[] = [];
  readonly #transport: AcpTransport;
  readonly #sessionId: string;
  readonly #agentName: string;
  readonly #options: FakePeerOptions;

  constructor(transport: AcpTransport, sessionId: string, agentName: string, options: FakePeerOptions = {}) {
    this.#transport = transport;
    this.#sessionId = sessionId;
    this.#agentName = agentName;
    this.#options = options;
    transport.subscribe((message) => {
      void this.#receive(message);
    });
  }

  async #receive(message: AcpJsonRpcMessage): Promise<void> {
    if (message.method) this.methods.push(message.method);
    if (message.id === undefined || message.id === null) return;
    if (message.method === "initialize") {
      await this.#transport.send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: {} },
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
    if (message.method === "session/prompt") {
      const delay = this.#options.promptDelayMs ?? 0;
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
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
): AcpTransport {
  const link = linkAcpTransports();
  new FakePeer(link.agent, sessionId, agentName, options);
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
