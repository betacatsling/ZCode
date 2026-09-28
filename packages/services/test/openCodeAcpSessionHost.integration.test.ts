/**
 * P6 thin knife — OpenCode/Goose ACP opt-in factories through SessionHost (fake transport).
 *
 * Proves same-protocol Agents register via explicit factory + loadExplicit trust list
 * without changing lazy Host defaults or the shared ACP session machine. Goose SessionHost
 * path is symmetric to OpenCode (#75).
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

/** Minimal fake ACP peer: initialize / session/new / session/prompt. */
class FakePeer {
  readonly methods: string[] = [];
  readonly #transport: AcpTransport;
  readonly #sessionId: string;
  readonly #agentName: string;

  constructor(transport: AcpTransport, sessionId: string, agentName: string) {
    this.#transport = transport;
    this.#sessionId = sessionId;
    this.#agentName = agentName;
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

function openFakeTransport(agentName: string, sessionId: string): AcpTransport {
  const link = linkAcpTransports();
  new FakePeer(link.agent, sessionId, agentName);
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
