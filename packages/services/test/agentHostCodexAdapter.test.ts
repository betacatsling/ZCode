import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexHarnessAdapter } from "../src/agent-adapters/codex/codexHarnessAdapter.js";
import type { AgentEvent, BindingPlan, SessionSpec } from "@zcode/shared/agent-host";

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  kill() {
    this.exitCode = 0;
    this.emit("exit", 0);
    return true;
  }
  send(value: unknown) {
    this.stdout.write(`${JSON.stringify(value)}\n`);
  }
}
const selection = {
  providerId: "test",
  modelId: "first",
  options: { reasoningLevel: "off" as const },
};
const spec: SessionSpec = {
  schemaVersion: 1,
  hostSessionId: "session",
  execution: { targetId: "target", workspaceIdentity: "workspace", worktreePath: tmpdir() },
  harness: { id: "codex", adapterVersion: "0.156.1" },
  modelBinding: { kind: "host-managed", selection },
};
const plan: BindingPlan = {
  schemaVersion: 1,
  hostSessionId: "session",
  targetId: "target",
  harnessId: "codex",
  adapterVersion: "0.156.1",
  catalogFingerprint: "fixture",
  requested: spec.modelBinding,
  effective: selection,
  route: "responses-gateway",
  support: { support: "supported" },
  capabilities: {},
};

function fakeCodex(options: { delayStart?: boolean; failInterrupt?: boolean } = {}) {
  const processes: FakeProcess[] = [];
  const requests: Array<{
    id?: number;
    method: string;
    params: Record<string, unknown>;
    child: FakeProcess;
  }> = [];
  const tokens: string[] = [];
  const replies: unknown[] = [];
  const spawnProcess = (
    _command: string,
    args: readonly string[],
    launchOptions: { env?: NodeJS.ProcessEnv },
  ) => {
    const child = new FakeProcess();
    if (args[0] === "--version")
      queueMicrotask(() => {
        child.stdout.end("codex-cli 0.156.1\n");
        child.emit("exit", 0);
      });
    else {
      processes.push(child);
      tokens.push(launchOptions.env?.ZCODE_CODEX_GATEWAY_TOKEN ?? "");
      let buffer = "";
      child.stdin.on("data", (chunk: Buffer) => {
        buffer += chunk.toString();
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const value = JSON.parse(buffer.slice(0, end)) as {
            id?: number;
            method?: string;
            params?: Record<string, unknown>;
          };
          buffer = buffer.slice(end + 1);
          if (!value.method) {
            replies.push(value);
            continue;
          }
          requests.push({ id: value.id, method: value.method, params: value.params ?? {}, child });
          if (value.id === undefined) continue;
          const result =
            value.method === "thread/start" || value.method === "thread/resume"
              ? {
                  thread: { id: "native-thread" },
                  model: `alias-${processes.length}`,
                  modelProvider: "zcode",
                }
              : value.method === "turn/start"
                ? { turn: { id: `native-turn-${processes.length}` } }
                : {};
          if (value.method === "turn/start" && options.delayStart) continue;
          queueMicrotask(() =>
            child.send(
              options.failInterrupt && value.method === "turn/interrupt"
                ? { id: value.id, error: { code: -1 } }
                : { id: value.id, result },
            ),
          );
        }
      });
    }
    return child as any;
  };
  return { spawnProcess, processes, requests, tokens, replies };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("fixture event not received");
}

test("two frozen model leases restart pinned process and resume native thread without replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-adapter-"));
  const f = fakeCodex();
  const issued: string[] = [];
  const revoked: string[] = [];
  const events: AgentEvent[] = [];
  const adapter = new CodexHarnessAdapter({
    root,
    spawnProcess: f.spawnProcess as any,
    lease: {
      gatewayUrl: "http://127.0.0.1:54321/v1",
      gateway: { issueToken: async () => "", revokeToken: (token) => revoked.push(token) },
      issue: async (input) => {
        issued.push(`${input.turnId}:${input.runtimeEpoch}`);
        return { token: `token-${issued.length}`, modelAlias: `alias-${issued.length}` };
      },
    },
  });
  try {
    const binding = await adapter.create(spec, plan);
    adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
    const firstRun = adapter.send({
      type: "send",
      commandId: "one",
      hostSessionId: spec.hostSessionId,
      turnId: "host-turn-1",
      text: "first",
    });
    await until(() => f.requests.some((entry) => entry.method === "turn/start"));
    const first = f.processes[0]!;
    first.send({
      id: 90,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "native-thread", turnId: "native-turn-1", itemId: "item-1" },
    });
    await until(() => events.some((event) => event.kind === "interaction.requested"));
    const interaction = events.find((event) => event.kind === "interaction.requested")!;
    await adapter.resolveInteraction({
      type: "resolveInteraction",
      commandId: "deny",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: binding.runtimeEpoch,
      turnId: "host-turn-1",
      interactionId: interaction.interactionId,
      decision: "deny",
    });
    assert.deepEqual(f.replies[0], { id: 90, result: { decision: "decline" } });
    first.send({
      method: "turn/completed",
      params: { threadId: "native-thread", turn: { id: "native-turn-1", status: "completed" } },
    });
    await until(() => revoked.includes("token-1"));
    await firstRun;
    const secondRun = adapter.send({
      type: "send",
      commandId: "two",
      hostSessionId: spec.hostSessionId,
      turnId: "host-turn-2",
      text: "second",
    });
    await until(() => f.requests.filter((entry) => entry.method === "turn/start").length === 2);
    assert.deepEqual(f.tokens, ["token-1", "token-2"]);
    assert.equal(f.requests.filter((entry) => entry.method === "thread/start").length, 1);
    assert.equal(f.requests.filter((entry) => entry.method === "thread/resume").length, 1);
    assert.deepEqual(
      f.requests
        .filter((entry) => entry.method === "turn/start")
        .map((entry) => entry.params.input),
      [[{ type: "text", text: "first" }], [{ type: "text", text: "second" }]],
    );
    first.send({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { threadId: "native-thread", turnId: "native-turn-1", itemId: "late" },
    });
    await assert.rejects(
      adapter.resolveInteraction({
        type: "resolveInteraction",
        commandId: "late",
        hostSessionId: spec.hostSessionId,
        runtimeEpoch: binding.runtimeEpoch,
        turnId: "host-turn-1",
        interactionId: interaction.interactionId,
        decision: "allow",
      }),
      /stale/,
    );
    await adapter.cancelTurn({
      type: "cancelTurn",
      commandId: "cancel",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: binding.runtimeEpoch,
      turnId: "host-turn-2",
    });
    assert.deepEqual(revoked, ["token-1"]);
    f.processes[1]!.send({
      method: "turn/completed",
      params: {
        threadId: "native-thread",
        turn: { id: "native-turn-2", status: "interrupted" },
      },
    });
    await secondRun;
    assert.deepEqual(revoked, ["token-1", "token-2"]);
    assert.equal(events.filter((event) => event.kind === "turn.finished").length, 2);
    assert.equal(issued.length, 2);
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("reasoning-high and wrong target fail before any lease or native effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-off-"));
  let issued = 0;
  const adapter = new CodexHarnessAdapter({
    root,
    lease: {
      gatewayUrl: "http://127.0.0.1:54321/v1",
      gateway: { issueToken: async () => "", revokeToken: () => {} },
      issue: async () => {
        issued++;
        throw new Error("not expected");
      },
    },
  });
  try {
    await assert.rejects(
      adapter.create(spec, {
        ...plan,
        effective: { ...selection, options: { reasoningLevel: "high" } },
      }),
      /exact supported off-only/,
    );
    assert.equal(
      (
        await adapter.hostManagedSupport(
          { id: "target", kind: "local", platform: process.platform as "darwin", available: true },
          { ...selection, options: { reasoningLevel: "high" } },
        )
      ).support,
      "unsupported",
    );
    assert.equal(issued, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "pinned native CLI resumes two turns with distinct frozen Gateway models through SDK and fake upstream",
  { skip: process.env.ZCODE_CODEX_ADAPTER_JOIN !== "1", timeout: 90000 },
  async () => {
    const { createServer } = await import("node:http");
    const { once } = await import("node:events");
    const { AiSdkModelAdapter } = await import("@zcode/adapters");
    const { createModelGateway } = await import("../src/model-gateway/gateway.js");
    const { responsesProtocol } = await import("../src/model-gateway/ingress/responses.js");
    const { createCodexGatewayLeaseIssuer } =
      await import("../src/agent-adapters/codex/createCodexGatewayLeaseIssuer.js");
    const root = await mkdtemp(join(tmpdir(), "codex-adapter-real-"));
    const seen: Array<{ model: string; input: unknown }> = [];
    const upstream = createServer(async (request, response) => {
      try {
        assert.equal(request.url, "/v1/responses");
        let raw = "";
        for await (const chunk of request) {
          raw += String(chunk);
          assert.ok(raw.length < 256000);
        }
        const body = JSON.parse(raw) as { model: string; input: unknown };
        seen.push({ model: body.model, input: body.input });
        const id = `resp-${seen.length}`;
        const item = {
          id: `message-${seen.length}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: `reply-${seen.length}` }],
        };
        const frame = (type: string, fields: object) =>
          `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          frame("response.created", {
            response: { id, model: body.model, created_at: 1760000000 },
          }) +
            frame("response.output_item.added", {
              output_index: 0,
              item: { type: "message", id: item.id },
            }) +
            frame("response.output_text.delta", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: item.content[0]!.text,
            }) +
            frame("response.output_item.done", { output_index: 0, item }) +
            frame("response.completed", {
              response: { id, usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } },
            }) +
            "data: [DONE]\n\n",
        );
      } catch {
        response.writeHead(500).end();
      }
    });
    let gateway: ReturnType<typeof createModelGateway> | undefined;
    let adapter: CodexHarnessAdapter | undefined;
    try {
      upstream.listen(0, "127.0.0.1");
      await once(upstream, "listening");
      const address = upstream.address();
      assert.ok(address && typeof address !== "string");
      const modelAdapter = new AiSdkModelAdapter({ retry: { maxAttempts: 1 } });
      const models = new Map(
        ["first", "second"].map((name) => [
          name,
          modelAdapter.createModel({
            providerId: "synthetic",
            modelId: name,
            providerConfig: {
              access: { type: "api-key", apiKey: "fake-key" },
              api: { type: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1` },
            } as Parameters<typeof modelAdapter.createModel>[0]["providerConfig"],
            modelConfig: {
              properties: {
                requiresMfjsToolSchema: false,
                contextWindow: 8192,
                inputFormat: {
                  supportsText: true,
                  supportsImage: false,
                  supportsVideo: false,
                  supportsAudio: false,
                  supportsPdf: false,
                },
                outputFormat: { supportsText: true },
                supportsToolCall: true,
                supportsJsonSchemaOutput: false,
                supportsNativeWebSearch: false,
                supportsMidConversationSystem: true,
              },
              optionSpecs: {
                reasoningLevel: { values: ["off"], map: "{}" },
                maxOutputTokens: { max: 2048, map: '{"max_output_tokens": maxOutputTokens}' },
              },
            } as Parameters<typeof modelAdapter.createModel>[0]["modelConfig"],
            options: { reasoningLevel: "off", maxOutputTokens: 2048 },
          }),
        ]),
      );
      gateway = createModelGateway({
        protocols: [responsesProtocol],
        resolveModel: (binding) => models.get(binding.effectiveSelection.modelId)!,
        limits: { maxBodyBytes: 256000, maxConcurrentRequests: 3 },
      });
      const { url } = await gateway.start();
      const firstSelection = {
        providerId: "synthetic",
        modelId: "first",
        options: { reasoningLevel: "off" as const },
      };
      const realPlan: BindingPlan = {
        ...plan,
        requested: { kind: "host-managed", selection: firstSelection },
        effective: firstSelection,
      };
      const issuer = createCodexGatewayLeaseIssuer({ gateway, gatewayUrl: `${url}/v1` });
      const issuedTokens: string[] = [];
      adapter = new CodexHarnessAdapter({
        root,
        lease: {
          ...issuer,
          issue: async (input) => {
            const lease = await issuer.issue(input);
            issuedTokens.push(lease.token);
            return lease;
          },
        },
        resolveTurnPlan: async (_spec, previous, turnId) =>
          turnId === "second"
            ? {
                ...previous,
                requested: {
                  kind: "host-managed",
                  selection: { ...firstSelection, modelId: "second" },
                },
                effective: { ...firstSelection, modelId: "second" },
              }
            : previous,
      });
      const binding = await adapter.create(spec, realPlan);
      const events: AgentEvent[] = [];
      adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
      const firstRun = adapter.send({
        type: "send",
        commandId: "first",
        hostSessionId: spec.hostSessionId,
        turnId: "first",
        text: "say one",
      });
      await until(() =>
        events.some((event) => event.kind === "turn.finished" && event.turnId === "first"),
      );
      await firstRun;
      const secondRun = adapter.send({
        type: "send",
        commandId: "second",
        hostSessionId: spec.hostSessionId,
        turnId: "second",
        text: "say two",
      });
      // 修复依据：旧 turn 的迟到/辅助请求不得在新 Model 绑定上取得授权。
      const oldRoute = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${issuedTokens[0]}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "zcode-stale", stream: true, input: [] }),
      });
      assert.equal(oldRoute.status, 401);
      await until(() =>
        events.some((event) => event.kind === "turn.finished" && event.turnId === "second"),
      );
      await secondRun;
      assert.equal(binding.backendVersion, "0.156.1");
      assert.deepEqual(
        seen.map((item) => item.model),
        ["first", "second"],
      );
      assert.ok(
        JSON.stringify(seen[1]!.input).includes("reply-1"),
        "second native turn must retain thread context",
      );
      assert.deepEqual(
        events.filter((event) => event.kind === "turn.finished").map((event) => event.outcome),
        ["success", "success"],
      );
    } finally {
      await adapter?.shutdown();
      await gateway?.close();
      upstream.closeAllConnections();
      upstream.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("native child death revokes lease and refuses an automatic prompt retry", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-adapter-death-"));
  const f = fakeCodex();
  const revoked: string[] = [];
  let leases = 0;
  const events: AgentEvent[] = [];
  const adapter = new CodexHarnessAdapter({
    root,
    spawnProcess: f.spawnProcess as any,
    lease: {
      gatewayUrl: "http://127.0.0.1:54321/v1",
      gateway: { issueToken: async () => "", revokeToken: (token) => revoked.push(token) },
      issue: async () => {
        leases++;
        return { token: `token-${leases}`, modelAlias: `alias-${leases}` };
      },
    },
  });
  try {
    await adapter.create(spec, plan);
    adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
    const run = adapter.send({
      type: "send",
      commandId: "first",
      hostSessionId: spec.hostSessionId,
      turnId: "turn-1",
      text: "once",
    });
    await until(() => f.processes.length === 1);
    f.processes[0]!.kill();
    await assert.rejects(run, /execution unknown/);
    await until(() => revoked.includes("token-1"));
    await assert.rejects(
      adapter.send({
        type: "send",
        commandId: "retry",
        hostSessionId: spec.hostSessionId,
        turnId: "turn-2",
        text: "do not replay",
      }),
      /execution unknown/,
    );
    assert.equal(leases, 1);
    assert.equal(events.find((event) => event.kind === "turn.finished")?.outcome, "unknown");
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupt ACK retains Host send and lease until matching native completion; late tool effect stays live", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-ack-"));
  const f = fakeCodex();
  const revoked: string[] = [],
    events: AgentEvent[] = [];
  const adapter = new CodexHarnessAdapter({
    root,
    spawnProcess: f.spawnProcess as any,
    lease: {
      gatewayUrl: "http://127.0.0.1:54321/v1",
      gateway: { issueToken: async () => "", revokeToken: (token) => revoked.push(token) },
      issue: async () => ({ token: "ack-token", modelAlias: "alias-1" }),
    },
  });
  try {
    const binding = await adapter.create(spec, plan);
    adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
    let settled = false;
    const send = adapter
      .send({
        type: "send",
        commandId: "ack",
        hostSessionId: spec.hostSessionId,
        turnId: "ack-turn",
        text: "hold",
      })
      .finally(() => {
        settled = true;
      });
    await until(() => f.requests.some((request) => request.method === "turn/start"));
    await adapter.cancelTurn({
      type: "cancelTurn",
      commandId: "interrupt",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: binding.runtimeEpoch,
      turnId: "ack-turn",
    });
    const child = f.processes[0]!;
    child.send({
      method: "item/completed",
      params: {
        threadId: "native-thread",
        turnId: "native-turn-1",
        item: { id: "late-tool", type: "commandExecution", command: "late", exitCode: 0 },
      },
    });
    assert.equal(settled, false);
    assert.deepEqual(revoked, []);
    assert.equal(
      events.some((event) => event.kind === "turn.finished"),
      false,
    );
    await assert.rejects(
      adapter.send({
        type: "send",
        commandId: "next",
        hostSessionId: spec.hostSessionId,
        turnId: "next",
        text: "next",
      }),
      /busy/,
    );
    child.send({
      method: "turn/completed",
      params: { threadId: "native-thread", turn: { id: "native-turn-1", status: "interrupted" } },
    });
    await send;
    assert.deepEqual(revoked, ["ack-token"]);
    assert.deepEqual(
      events.filter((event) => event.kind === "turn.finished").map((event) => event.outcome),
      ["cancelled"],
    );
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("same-thread stale early completion cannot settle new native ID or revoke lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-early-"));
  const f = fakeCodex({ delayStart: true });
  const revoked: string[] = [],
    events: AgentEvent[] = [];
  const adapter = new CodexHarnessAdapter({
    root,
    spawnProcess: f.spawnProcess as any,
    lease: {
      gatewayUrl: "http://127.0.0.1:54321/v1",
      gateway: { issueToken: async () => "", revokeToken: (token) => revoked.push(token) },
      issue: async () => ({ token: "early-token", modelAlias: "alias-1" }),
    },
  });
  try {
    await adapter.create(spec, plan);
    adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
    const send = adapter.send({
      type: "send",
      commandId: "early",
      hostSessionId: spec.hostSessionId,
      turnId: "new",
      text: "new",
    });
    await until(() => f.requests.some((request) => request.method === "turn/start"));
    const child = f.processes[0]!,
      request = f.requests.find((entry) => entry.method === "turn/start")!;
    child.send({
      method: "turn/completed",
      params: { threadId: "native-thread", turn: { id: "old-turn", status: "completed" } },
    });
    // The fake process records RPC requests with IDs to release the deferred start response.
    child.send({ id: request.id, result: { turn: { id: "native-turn-1" } } });
    await until(() => events.some((event) => event.kind === "turn.started"));
    assert.deepEqual(revoked, []);
    assert.equal(
      events.some((event) => event.kind === "turn.finished"),
      false,
    );
    child.send({
      method: "turn/completed",
      params: { threadId: "native-thread", turn: { id: "native-turn-1", status: "completed" } },
    });
    await send;
    assert.deepEqual(revoked, ["early-token"]);
    assert.deepEqual(
      events.filter((event) => event.kind === "turn.finished").map((event) => event.outcome),
      ["success"],
    );
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed interrupt fences reuse as unknown, never reports cancelled", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-interrupt-error-"));
  const f = fakeCodex({ failInterrupt: true });
  const events: AgentEvent[] = [];
  const adapter = new CodexHarnessAdapter({
    root,
    spawnProcess: f.spawnProcess as any,
    lease: {
      gatewayUrl: "http://127.0.0.1:54321/v1",
      gateway: { issueToken: async () => "", revokeToken: () => {} },
      issue: async () => ({ token: "error-token", modelAlias: "alias-1" }),
    },
  });
  try {
    const binding = await adapter.create(spec, plan);
    adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
    const send = adapter.send({
      type: "send",
      commandId: "error",
      hostSessionId: spec.hostSessionId,
      turnId: "error-turn",
      text: "hold",
    });
    void send.catch(() => {});
    await until(() => f.requests.some((entry) => entry.method === "turn/start"));
    const cancel = adapter.cancelTurn({
      type: "cancelTurn",
      commandId: "cancel",
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: binding.runtimeEpoch,
      turnId: "error-turn",
    });
    await until(() => f.requests.some((entry) => entry.method === "turn/interrupt"));
    assert.equal(f.requests.filter((entry) => entry.method === "turn/interrupt").length, 1);
    await assert.rejects(cancel);
    await assert.rejects(send, /unknown/);
    assert.deepEqual(
      events.filter((event) => event.kind === "turn.finished").map((event) => event.outcome),
      ["unknown"],
    );
    await assert.rejects(
      adapter.send({
        type: "send",
        commandId: "retry",
        hostSessionId: spec.hostSessionId,
        turnId: "retry",
        text: "retry",
      }),
      /unknown/,
    );
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
