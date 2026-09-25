import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexHarnessAdapter } from "../src/agent-adapters/codex/codexHarnessAdapter.js";
import { codexTrustedManifest } from "../src/agent-adapters/codex/codexAdapterContract.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { codexSessionProfile } from "../src/agent-adapters/codex/codexBinding.js";
import { projectCodexNotification } from "../src/agent-adapters/codex/codexCanonicalProjection.js";
import type { AgentEvent, BindingPlan, SessionSpecV2 } from "@zcode/shared/agent-host";

class FakeProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  finish(exitCode: number | null, signalCode: NodeJS.Signals | null = null) {
    this.exitCode = exitCode;
    this.signalCode = signalCode;
    this.emit("exit", exitCode, signalCode);
  }
  kill(signal: NodeJS.Signals = "SIGTERM") {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    this.finish(null, signal);
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
const spec: SessionSpecV2 = {
  schemaVersion: 2,
  projectId: "project",
  workspaceId: "workspace-id",
  hostSessionId: "session",
  execution: {
    targetId: "target",
    workspaceIdentity: "workspace",
    worktreePath: tmpdir(),
    worktreeGeneration: "generation",
    cwdRelativeToWorktree: ".",
  },
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
        child.finish(0);
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
async function bounded<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`fixture deadline ${milliseconds}ms`)),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

test("Codex absolute usage preserves absent metrics separately from explicit zero", () => {
  const events: Array<Record<string, unknown>> = [];
  const project = (last: Record<string, unknown>) =>
    projectCodexNotification(
      {
        kind: "notification",
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "native-thread",
          turnId: "native-turn",
          tokenUsage: { last },
        },
      },
      "native-thread",
      "host-turn",
      (event) => events.push(event),
    );

  project({ inputTokens: 0 });
  project({ outputTokens: 0 });
  project({});
  assert.deepEqual(events, [
    {
      kind: "usage.accounted",
      turnId: "host-turn",
      sourceId: "codex-native-turn-usage",
      accounting: "absolute",
      inputTokens: 0,
    },
    {
      kind: "usage.accounted",
      turnId: "host-turn",
      sourceId: "codex-native-turn-usage",
      accounting: "absolute",
      outputTokens: 0,
    },
  ]);
});

test("per-turn leases restart pinned process and resume native thread without replay", async () => {
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
    await adapter.prepareTurn(spec, {
      turnId: "host-turn-1",
      runtimeEpoch: binding.runtimeEpoch,
      plan: plan,
    });
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
    await adapter.prepareTurn(spec, {
      turnId: "host-turn-2",
      runtimeEpoch: binding.runtimeEpoch,
      plan: plan,
    });
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
  "pinned native CLI Host keeps its selected model and accounts two usage snapshots once",
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
    let host: SessionHost | undefined;
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
      const hostSpec: SessionSpecV2 = {
        ...spec,
        hostSessionId: randomUUID(),
        modelBinding: { kind: "host-managed", selection: firstSelection },
        execution: { ...spec.execution, worktreePath: join(root, "worktree") },
      };
      const hostRoot = join(root, "journal");
      await mkdir(hostSpec.execution.worktreePath, { recursive: true });
      const catalog = {
        fingerprint: "synthetic-catalog",
        validateSelection: () => ({ ok: true as const }),
      };
      const target = {
        id: hostSpec.execution.targetId,
        kind: "local" as const,
        platform: process.platform as "darwin" | "linux",
        available: true,
      };
      const issuer = createCodexGatewayLeaseIssuer({ gateway, gatewayUrl: `${url}/v1` });
      const issuedTokens: string[] = [];
      adapter = new CodexHarnessAdapter({
        root: join(root, "profiles"),
        lease: {
          ...issuer,
          issue: async (input) => {
            const lease = await issuer.issue(input);
            issuedTokens.push(lease.token);
            return lease;
          },
        },
      });
      const registry = new HarnessRegistry();
      registry.registerTrusted(codexTrustedManifest, () => adapter!);
      host = await SessionHost.create({
        root: hostRoot,
        spec: hostSpec,
        registry,
        target,
        catalog,
      });
      const firstReceipt = await host.dispatch({
        type: "send",
        commandId: "first",
        hostSessionId: hostSpec.hostSessionId,
        turnId: "first",
        text: "say one",
      });
      assert.equal(firstReceipt.status, "accepted");
      await host.whenIdle();
      assert.equal(host.queryCommand("first")?.status, "completed");
      const secondReceipt = await host.dispatch({
        type: "send",
        commandId: "second",
        hostSessionId: hostSpec.hostSessionId,
        turnId: "second",
        text: "say two",
      });
      assert.equal(secondReceipt.status, "accepted");
      await host.whenIdle();
      assert.equal(host.queryCommand("second")?.status, "completed");
      // 修复依据：旧 turn 的迟到/辅助请求不得在新 Model 绑定上取得授权。
      const oldRoute = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${issuedTokens[0]}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "zcode-stale", stream: true, input: [] }),
      });
      assert.equal(oldRoute.status, 401);
      assert.equal(host.binding.backendVersion, "0.156.1");
      assert.deepEqual(
        seen.map((item) => item.model),
        ["first", "first"],
      );
      assert.ok(
        JSON.stringify(seen[1]!.input).includes("reply-1"),
        "second native turn must retain thread context",
      );
      const events = host.eventsSince(0);
      assert.deepEqual(
        events.filter((event) => event.kind === "turn.finished").map((event) => event.outcome),
        ["success", "success"],
      );
      const usageEvents = events.filter(
        (event) => event.kind === "usage.accounted" || event.kind === "usage.reported",
      );
      for (const turnId of ["first", "second"]) {
        const turnUsage = usageEvents.filter((event) => event.turnId === turnId);
        assert.ok(turnUsage.length > 0, `native ${turnId} must report its matched-turn usage`);
        assert.ok(
          turnUsage.every(
            (event) =>
              event.kind === "usage.accounted" &&
              event.sourceId === "codex-native-turn-usage" &&
              event.accounting === "absolute",
          ),
          `native ${turnId} usage must be source-scoped absolute snapshots`,
        );
      }
      assert.deepEqual(host.snapshot().usage.cumulative, {
        inputTokens: 20,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
      const switchedSpec: SessionSpecV2 = {
        ...hostSpec,
        modelBinding: {
          kind: "host-managed",
          selection: { ...firstSelection, modelId: "second" },
        },
      };
      await assert.rejects(
        SessionHost.open({ root: hostRoot, spec: switchedSpec, registry, target, catalog }),
        /session identity or configuration mismatch/,
      );
      assert.equal(issuedTokens.length, 2, "model-switch refusal must not issue a lease");
      assert.equal(seen.length, 2, "model-switch refusal must not cause another upstream call");
    } finally {
      await host?.close();
      await adapter?.shutdown();
      await gateway?.close();
      upstream.closeAllConnections();
      upstream.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

for (const nativeFault of ["signal-death", "fragmented-unterminated", "aggregate-early"] as const) {
  test(
    `pinned OS child ${nativeFault} behind Host ACK persists unknown across independent reopen without replay`,
    {
      skip:
        process.env[
          nativeFault === "signal-death"
            ? "ZCODE_CODEX_HOST_OS_DEATH"
            : "ZCODE_CODEX_HOST_OS_BYTE_FAULT"
        ] !== "1",
      timeout: 45000,
    },
    async (t) => {
      const { createServer } = await import("node:http");
      const { once } = await import("node:events");
      const root = await mkdtemp(join(tmpdir(), "codex-host-os-death-"));
      const worktree = join(root, "worktree");
      await mkdir(worktree);
      const profileRoot = join(root, "profiles");
      const journalRoot = join(root, "journal");
      const hostSpec: SessionSpecV2 = {
        ...spec,
        hostSessionId: randomUUID(),
        execution: { ...spec.execution, worktreePath: worktree },
      };
      const target = {
        id: hostSpec.execution.targetId,
        kind: "local" as const,
        platform: process.platform as "darwin" | "linux",
        available: true,
      };
      const catalog = {
        fingerprint: "synthetic-catalog",
        validateSelection: () => ({ ok: true as const }),
      };
      const revoked: string[] = [];
      let leaseIssues = 0;
      let upstreamRequests = 0;
      let appServerCount = 0;
      let nativeProcess: ChildProcessWithoutNullStreams | undefined;
      let injectedStdout: PassThrough | undefined;
      let heldAckCount = 0;
      let resolveHeldAck!: () => void;
      const heldAck = new Promise<void>((resolve) => {
        resolveHeldAck = resolve;
      });
      const upstream = createServer((request, response) => {
        if (request.method !== "POST" || request.url !== "/v1/responses") {
          response.writeHead(404).end();
          return;
        }
        upstreamRequests++;
        void (async () => {
          let bytes = 0;
          for await (const chunk of request) {
            bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
            if (bytes > 1024 * 1024) {
              response.writeHead(413).end();
              return;
            }
          }
          response.writeHead(503).end("synthetic upstream unavailable");
        })().catch(() => response.destroy());
      });
      const spawnProcess: typeof spawn = (command, args, options) => {
        const child = spawn(command, args, options);
        if (args?.[0] !== "app-server") return child;
        appServerCount++;
        nativeProcess = child as ChildProcessWithoutNullStreams;
        const originalStdout = nativeProcess.stdout;
        const output = new PassThrough();
        injectedStdout = output;
        nativeProcess.stdout = output;
        const decoder = new StringDecoder("utf8");
        let buffered = "";
        originalStdout.on("data", (chunk: Buffer) => {
          buffered += decoder.write(chunk);
          for (;;) {
            const end = buffered.indexOf("\n");
            if (end < 0) break;
            const line = buffered.slice(0, end + 1);
            buffered = buffered.slice(end + 1);
            const frame = JSON.parse(line) as { result?: { turn?: { id?: unknown } } };
            if (typeof frame.result?.turn?.id === "string" && heldAckCount === 0) {
              heldAckCount++;
              resolveHeldAck();
            } else {
              output.write(line);
            }
          }
        });
        originalStdout.once("end", () => output.end());
        originalStdout.once("error", (error) => output.destroy(error));
        return child;
      };
      let host: SessionHost | undefined;
      let reopened: SessionHost | undefined;
      const adapters: CodexHarnessAdapter[] = [];
      let gatewayUrl: string | undefined;
      const makeAdapter = () => {
        if (!gatewayUrl) throw new Error("owned fake upstream is not listening");
        const adapter = new CodexHarnessAdapter({
          root: profileRoot,
          executable: "codex",
          spawnProcess,
          lease: {
            gatewayUrl,
            gateway: { issueToken: async () => "", revokeToken: (token) => revoked.push(token) },
            issue: async () => {
              leaseIssues++;
              return {
                token: `synthetic-os-death-${leaseIssues}`,
                modelAlias: "synthetic-os-model",
              };
            },
          },
        });
        adapters.push(adapter);
        return adapter;
      };
      let adapter: CodexHarnessAdapter | undefined;
      const makeRegistry = (current: CodexHarnessAdapter) => {
        const registry = new HarnessRegistry();
        registry.registerTrusted(codexTrustedManifest, () => current);
        return registry;
      };
      try {
        upstream.listen(0, "127.0.0.1");
        await bounded(once(upstream, "listening"), 2000);
        const address = upstream.address();
        assert.ok(address && typeof address !== "string");
        gatewayUrl = `http://127.0.0.1:${address.port}/v1`;
        // The app-server targets this test-owned OS-assigned loopback fake upstream only.
        const initialAdapter = makeAdapter();
        adapter = initialAdapter;
        host = await SessionHost.create({
          root: journalRoot,
          spec: hostSpec,
          registry: makeRegistry(initialAdapter),
          target,
          catalog,
        });
        const accepted = await host.dispatch({
          type: "send",
          commandId: "accepted-os-once",
          hostSessionId: hostSpec.hostSessionId,
          turnId: "os-turn",
          text: "synthetic request before held native ACK",
        });
        assert.equal(accepted.status, "accepted");
        await bounded(heldAck, 15000);
        assert.equal(
          heldAckCount,
          1,
          "the stdout proxy withheld one genuine native turn/start ACK",
        );
        assert.ok(nativeProcess?.pid, "one actual pinned app-server PID must be owned");
        // ACK delivery order is not a provider-effect proof; record zero or more actual fake-upstream requests.

        const nativeExit = once(nativeProcess, "exit");
        if (nativeFault === "signal-death") nativeProcess.kill("SIGKILL");
        else if (nativeFault === "fragmented-unterminated") {
          // 修复依据：真实进程的预 ACK 流也必须按累计字节拒绝，不能只依赖模拟子进程的同步退出。
          injectedStdout!.write(Buffer.alloc(600_000, 120));
          injectedStdout!.write(Buffer.alloc(500_000, 120));
        } else {
          const line = `${JSON.stringify({ method: "thread/name/updated", params: { payload: "x".repeat(600_000) } })}\n`;
          injectedStdout!.write(Buffer.from(line + line));
        }
        const [exitCode, signal] = await bounded(nativeExit, 3000);
        assert.ok(exitCode !== null || signal !== null, "actual native child must be OS-reaped");
        if (nativeFault === "signal-death") {
          assert.equal(exitCode, null);
          assert.equal(signal, "SIGKILL");
        }
        assert.equal(nativeProcess.exitCode, exitCode);
        assert.equal(nativeProcess.signalCode, signal);
        await bounded(host.whenIdle(), 5000);
        assert.equal(host.queryCommand("accepted-os-once")?.status, "execution-unknown");
        assert.deepEqual(
          revoked,
          ["synthetic-os-death-1"],
          "the admitted turn lease is revoked once",
        );
        assert.equal(
          host.eventsSince(0).find((event) => event.kind === "turn.finished")?.outcome,
          "unknown",
        );
        const requestsAtDeath = upstreamRequests;
        const duplicate = await host.dispatch({
          type: "send",
          commandId: "accepted-os-once",
          hostSessionId: hostSpec.hostSessionId,
          turnId: "os-turn",
          text: "synthetic request before held native ACK",
        });
        assert.equal(duplicate.status, "duplicate");
        const blocked = await host.dispatch({
          type: "send",
          commandId: "os-retry",
          hostSessionId: hostSpec.hostSessionId,
          turnId: "os-retry-turn",
          text: "must not be sent again",
        });
        assert.equal(blocked.status, "rejected");
        assert.equal(blocked.reasonCode, "execution-unknown");
        assert.equal(appServerCount, 1);
        await host.close();
        host = undefined;
        await adapter?.shutdown();

        const reopenedAdapter = makeAdapter();
        reopened = await SessionHost.open({
          root: journalRoot,
          spec: hostSpec,
          registry: makeRegistry(reopenedAdapter),
          target,
          catalog,
        });
        assert.equal(reopened.queryCommand("accepted-os-once")?.status, "execution-unknown");
        assert.equal(
          reopened.eventsSince(0).find((event) => event.kind === "turn.finished")?.outcome,
          "unknown",
        );
        const persistedDuplicate = await reopened.dispatch({
          type: "send",
          commandId: "accepted-os-once",
          hostSessionId: hostSpec.hostSessionId,
          turnId: "os-turn",
          text: "synthetic request before held native ACK",
        });
        assert.equal(persistedDuplicate.status, "duplicate");
        const afterReopen = await reopened.dispatch({
          type: "send",
          commandId: "os-retry-after-reopen",
          hostSessionId: hostSpec.hostSessionId,
          turnId: "os-retry-after-reopen",
          text: "must not be resent after independent reopen",
        });
        assert.equal(afterReopen.status, "rejected");
        assert.equal(afterReopen.reasonCode, "execution-unknown");
        assert.equal(leaseIssues, 1, "reopen and retry must not issue a replacement lease");
        assert.deepEqual(revoked, ["synthetic-os-death-1"]);
        assert.equal(appServerCount, 1, "no replacement native child may be launched");
        assert.equal(
          upstreamRequests,
          requestsAtDeath,
          "no upstream request may follow the blocked retry",
        );
        t.diagnostic(
          `pinned pid=${nativeProcess.pid} exit=${exitCode} signal=${signal}; fault=${nativeFault}; heldACK=${heldAckCount}; fakeRequestsAtFault=${upstreamRequests}; leaseIssues=${leaseIssues}; revokes=${revoked.length}; appServers=${appServerCount}; independentHost=reopened-unknown`,
        );
      } finally {
        if (nativeProcess && nativeProcess.exitCode === null && nativeProcess.signalCode === null) {
          const exit = once(nativeProcess, "exit");
          nativeProcess.kill("SIGKILL");
          await bounded(exit, 3000);
        }
        await host?.whenIdle().catch(() => {});
        await host?.close();
        await reopened?.whenIdle().catch(() => {});
        await reopened?.close();
        for (const current of adapters) await current.shutdown();
        upstream.closeAllConnections();
        await bounded(
          new Promise<void>((resolve, reject) => {
            upstream.close((error) => (error ? reject(error) : resolve()));
          }),
          2000,
        );
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

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
    const binding = await adapter.create(spec, plan);
    adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
    await adapter.prepareTurn(spec, {
      turnId: "turn-1",
      runtimeEpoch: binding.runtimeEpoch,
      plan: plan,
    });
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

for (const failure of ["death-before-ACK", "fragmented-unterminated", "aggregate-early"] as const) {
  test(`V2 Host accepted send ${failure}: durable unknown, single revoke and no replay`, async () => {
    const root = await mkdtemp(join(tmpdir(), `codex-host-${failure}-`));
    const f = fakeCodex({ delayStart: true });
    const revoked: string[] = [];
    const scoped: SessionSpecV2 = {
      ...spec,
      hostSessionId: randomUUID(),
      execution: { ...spec.execution, worktreePath: root },
    };
    const adapter = new CodexHarnessAdapter({
      root: join(root, "profiles"),
      spawnProcess: f.spawnProcess as any,
      lease: {
        gatewayUrl: "http://127.0.0.1:54321/v1",
        gateway: { issueToken: async () => "", revokeToken: (token) => revoked.push(token) },
        issue: async () => ({ token: "only-lease", modelAlias: "alias-1" }),
      },
    });
    const registry = new HarnessRegistry();
    registry.registerTrusted(codexTrustedManifest, () => adapter);
    let host: SessionHost | undefined;
    try {
      host = await SessionHost.create({
        root: join(root, "journal"),
        spec: scoped,
        registry,
        target: {
          id: scoped.execution.targetId,
          kind: "local",
          platform: process.platform as "darwin" | "linux",
          available: true,
        },
        catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true }) },
      });
      const receipt = await host.dispatch({
        type: "send",
        commandId: "accepted-once",
        hostSessionId: scoped.hostSessionId,
        turnId: "turn",
        text: "never replay this",
      });
      assert.equal(receipt.status, "accepted");
      await until(() => f.requests.some((request) => request.method === "turn/start"));
      const child = f.processes[0]!;
      if (failure === "death-before-ACK") child.kill();
      else if (failure === "fragmented-unterminated") {
        // Each fragment is below the frame ceiling; the accumulated unterminated tail is not.
        child.stdout.write(Buffer.from("x".repeat(600_000)));
        child.stdout.write(Buffer.from("x".repeat(500_000)));
      } else {
        for (let i = 0; i < 2; i++)
          child.send({
            method: "item/agentMessage/delta",
            params: {
              threadId: "native-thread",
              turnId: "native-turn-1",
              itemId: "item",
              delta: "x".repeat(600_000),
            },
          });
      }
      await host.whenIdle();
      assert.equal(host.queryCommand("accepted-once")?.status, "execution-unknown");
      assert.deepEqual(revoked, ["only-lease"]);
      assert.ok(
        child.exitCode !== null || child.signalCode !== null,
        "owned child must be reaped by transport close",
      );
      const duplicate = await host.dispatch({
        type: "send",
        commandId: "accepted-once",
        hostSessionId: scoped.hostSessionId,
        turnId: "turn",
        text: "never replay this",
      });
      assert.equal(duplicate.status, "duplicate");
      const next = await host.dispatch({
        type: "send",
        commandId: "retry",
        hostSessionId: scoped.hostSessionId,
        turnId: "retry",
        text: "not dispatched",
      });
      assert.equal(next.status, "rejected");
      assert.equal(next.reasonCode, "execution-unknown");
      assert.equal(f.processes.length, 1);
      await host.close();
      host = undefined;
      assert.equal(
        (await SessionHost.queryCommandHistory(join(root, "journal"), scoped, "accepted-once"))
          ?.status,
        "execution-unknown",
      );
    } finally {
      await host?.close();
      await adapter.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
}

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
    await adapter.prepareTurn(spec, {
      turnId: "ack-turn",
      runtimeEpoch: binding.runtimeEpoch,
      plan: plan,
    });
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
    const binding = await adapter.create(spec, plan);
    adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
    await adapter.prepareTurn(spec, {
      turnId: "new",
      runtimeEpoch: binding.runtimeEpoch,
      plan: plan,
    });
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
    await adapter.prepareTurn(spec, {
      turnId: "error-turn",
      runtimeEpoch: binding.runtimeEpoch,
      plan: plan,
    });
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

test("V2 creation/attach scopes binding and launches verified subdirectory cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-v2-"));
  const worktree = join(root, "worktree");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(worktree, "src"), { recursive: true });
  const scoped = {
    ...spec,
    execution: { ...spec.execution, worktreePath: worktree, cwdRelativeToWorktree: "src" },
  };
  const launches: string[] = [];
  const f = fakeCodex();
  const adapter = new CodexHarnessAdapter({
    root: join(root, "profiles"),
    spawnProcess: ((command: string, args: readonly string[], options: { cwd: string }) => {
      launches.push(options.cwd);
      return f.spawnProcess(command, args, options);
    }) as any,
    lease: {
      gatewayUrl: "http://127.0.0.1:54321/v1",
      gateway: { issueToken: async () => "", revokeToken: () => {} },
      issue: async () => ({ token: "scoped-token", modelAlias: "alias-1" }),
    },
  });
  try {
    await assert.rejects(adapter.create({ ...scoped, schemaVersion: 1 } as any, plan));
    const binding = await adapter.create(scoped, plan);
    assert.equal(binding.schemaVersion, 2);
    assert.equal(binding.worktreeGeneration, "generation");
    for (const other of [
      { ...binding, targetId: "other" },
      { ...binding, workspaceId: "other" },
      { ...binding, worktreeGeneration: "other" },
      { ...binding, harnessId: "other" },
      { ...binding, runtimeEpoch: "other" },
    ])
      await assert.rejects(adapter.attach(scoped, other, 0, plan), /stale Codex binding/);
    await adapter.attach(scoped, binding, 0, plan);
    await adapter.prepareTurn(scoped, {
      turnId: "turn",
      runtimeEpoch: binding.runtimeEpoch,
      plan: plan,
    });
    const send = adapter.send({
      type: "send",
      commandId: "scoped",
      hostSessionId: scoped.hostSessionId,
      turnId: "turn",
      text: "check",
    });
    await until(() => f.requests.some((r) => r.method === "turn/start"));
    f.processes[0]!.send({
      method: "turn/completed",
      params: { threadId: "native-thread", turn: { id: "native-turn-1", status: "completed" } },
    });
    await send;
    assert.equal(
      launches.at(-1),
      await (await import("node:fs/promises")).realpath(join(worktree, "src")),
    );
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("durable native provenance: never-started draft reopens; missing, ambiguous or lost established context refuses before native IO", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-provenance-"));
  const f = fakeCodex();
  const make = () =>
    new CodexHarnessAdapter({
      root,
      spawnProcess: f.spawnProcess as any,
      lease: {
        gatewayUrl: "http://127.0.0.1:54321/v1",
        gateway: { issueToken: async () => "", revokeToken: () => {} },
        issue: async () => ({
          token: `t-${f.processes.length}`,
          modelAlias: `alias-${f.processes.length + 1}`,
        }),
      },
    });
  const profile = codexSessionProfile(root, spec);
  let adapter = make();
  try {
    const binding = await adapter.create(spec, plan);
    await adapter.shutdown();
    adapter = make();
    // A lost create receipt cannot replace even a never-started profile with a new binding.
    const provenance = join(profile, `${binding.backendSessionId}.ownership.json`);
    const oldRecord = await readFile(provenance, "utf8");
    await assert.rejects(adapter.create(spec, plan), /native ownership unknown/);
    assert.equal(await readFile(provenance, "utf8"), oldRecord);
    // Host sequence may already include session-created, despite zero native turns.
    await adapter.attach(spec, binding, 1, plan);
    await adapter.shutdown();
    const initial = await readFile(provenance, "utf8");
    await writeFile(provenance, JSON.stringify({ ...JSON.parse(initial), state: "starting" }));
    adapter = make();
    await assert.rejects(adapter.attach(spec, binding, 1, plan), /native.*unknown|ownership/i);
    await writeFile(provenance, initial);
    await adapter.attach(spec, binding, 1, plan);
    await adapter.prepareTurn(spec, { turnId: "first", runtimeEpoch: binding.runtimeEpoch, plan });
    const send = adapter.send({
      type: "send",
      commandId: "first",
      hostSessionId: spec.hostSessionId,
      turnId: "first",
      text: "first",
    });
    await until(() => f.requests.some((r) => r.method === "turn/start"));
    f.processes[0]!.send({
      method: "turn/completed",
      params: { threadId: "native-thread", turn: { id: "native-turn-1", status: "completed" } },
    });
    await send;
    await adapter.shutdown();
    adapter = make();
    await adapter.attach(spec, binding, 4, plan);
    await adapter.shutdown();
    // Collision with an established profile must preserve BOTH durable ownership artifacts.
    const marker = join(profile, `${binding.backendSessionId}.thread`);
    const established = await readFile(provenance, "utf8");
    const originalMarker = await readFile(marker, "utf8");
    await assert.rejects(adapter.create(spec, plan), /native ownership unknown/);
    assert.equal(await readFile(provenance, "utf8"), established);
    assert.equal(await readFile(marker, "utf8"), originalMarker);
    await rm(marker);
    adapter = make();
    await assert.rejects(adapter.attach(spec, binding, 4, plan), /native.*unknown|ownership/i);
    await mkdir(profile, { recursive: true });
    await rm(profile, { recursive: true });
    await assert.rejects(adapter.attach(spec, binding, 4, plan), /native.*unknown|ownership/i);
    assert.equal(
      f.processes.length,
      1,
      "lost state must never allocate a replacement native context",
    );
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

for (const loss of ["starting", "lost-marker", "lost-profile"] as const) {
  test(`independent native ownership ${loss} refuses attach after committed turn`, async () => {
    const root = await mkdtemp(join(tmpdir(), `codex-${loss}-`));
    const f = fakeCodex();
    const make = () =>
      new CodexHarnessAdapter({
        root,
        spawnProcess: f.spawnProcess as any,
        lease: {
          gatewayUrl: "http://127.0.0.1:54321/v1",
          gateway: { issueToken: async () => "", revokeToken: () => {} },
          issue: async () => ({ token: "one", modelAlias: "alias-1" }),
        },
      });
    let adapter = make();
    try {
      const binding = await adapter.create(spec, plan);
      await adapter.prepareTurn(spec, {
        turnId: "first",
        runtimeEpoch: binding.runtimeEpoch,
        plan,
      });
      const sent = adapter.send({
        type: "send",
        commandId: "first",
        hostSessionId: spec.hostSessionId,
        turnId: "first",
        text: "once",
      });
      await until(() => f.requests.some((request) => request.method === "turn/start"));
      f.processes[0]!.send({
        method: "turn/completed",
        params: { threadId: "native-thread", turn: { id: "native-turn-1", status: "completed" } },
      });
      await sent;
      await adapter.shutdown();
      const profile = codexSessionProfile(root, spec);
      const record = join(profile, `${binding.backendSessionId}.ownership.json`);
      if (loss === "starting") {
        const saved = JSON.parse(await readFile(record, "utf8")) as object;
        await writeFile(record, JSON.stringify({ ...saved, state: "starting" }));
      } else if (loss === "lost-marker")
        await rm(join(profile, `${binding.backendSessionId}.thread`));
      else await rm(profile, { recursive: true });
      adapter = make();
      await assert.rejects(adapter.attach(spec, binding, 4, plan), /native ownership unknown/);
      assert.equal(f.processes.length, 1, "unknown context must not launch another child");
    } finally {
      await adapter.shutdown();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("pre-ACK pending event bytes fail closed before 128 count despite valid individual frames", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-early-bytes-"));
  const f = fakeCodex({ delayStart: true });
  const revoked: string[] = [];
  const adapter = new CodexHarnessAdapter({
    root,
    spawnProcess: f.spawnProcess as any,
    lease: {
      gatewayUrl: "http://127.0.0.1:54321/v1",
      gateway: { issueToken: async () => "", revokeToken: (t) => revoked.push(t) },
      issue: async () => ({ token: "early-byte-token", modelAlias: "alias-1" }),
    },
  });
  try {
    const binding = await adapter.create(spec, plan);
    await adapter.prepareTurn(spec, { turnId: "early", runtimeEpoch: binding.runtimeEpoch, plan });
    const sent = adapter.send({
      type: "send",
      commandId: "early",
      hostSessionId: spec.hostSessionId,
      turnId: "early",
      text: "input",
    });
    const unknown = assert.rejects(sent, /unknown|transport closed/);
    await until(() => f.requests.some((r) => r.method === "turn/start"));
    for (let i = 0; i < 2; i++)
      f.processes[0]!.send({
        method: "item/agentMessage/delta",
        params: {
          threadId: "native-thread",
          turnId: "native-turn-1",
          itemId: "item",
          delta: "x".repeat(600_000),
        },
      });
    await unknown;
    await assert.rejects(
      adapter.prepareTurn(spec, { turnId: "retry", runtimeEpoch: binding.runtimeEpoch, plan }),
      /unknown|stale/,
    );
    assert.deepEqual(revoked, ["early-byte-token"]);
    assert.equal(f.processes[0]!.exitCode, null);
    assert.equal(f.processes[0]!.signalCode, "SIGTERM");
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("old same-thread item/text/tool/usage before and after ACK cannot enter new Host turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-stale-events-"));
  const f = fakeCodex({ delayStart: true });
  const events: AgentEvent[] = [],
    revoked: string[] = [];
  const adapter = new CodexHarnessAdapter({
    root,
    spawnProcess: f.spawnProcess as any,
    lease: {
      gatewayUrl: "http://127.0.0.1:54321/v1",
      gateway: { issueToken: async () => "", revokeToken: (t) => revoked.push(t) },
      issue: async () => ({ token: "stale-token", modelAlias: "alias-1" }),
    },
  });
  try {
    const binding = await adapter.create(spec, plan);
    adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
    await adapter.prepareTurn(spec, {
      turnId: "new",
      runtimeEpoch: binding.runtimeEpoch,
      plan: plan,
    });
    const send = adapter.send({
      type: "send",
      commandId: "one",
      hostSessionId: spec.hostSessionId,
      turnId: "new",
      text: "new",
    });
    await until(() => f.requests.some((r) => r.method === "turn/start"));
    const child = f.processes[0]!;
    const stale = () => {
      child.send({
        method: "item/agentMessage/delta",
        params: { threadId: "native-thread", turnId: "old", itemId: "old-text", delta: "OLD" },
      });
      child.send({
        method: "item/completed",
        params: {
          threadId: "native-thread",
          turnId: "old",
          item: { id: "old-item", type: "agentMessage", text: "OLD" },
        },
      });
      child.send({
        method: "item/started",
        params: {
          threadId: "native-thread",
          turnId: "old",
          item: { id: "old-tool", type: "commandExecution" },
        },
      });
      child.send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "native-thread",
          turnId: "old",
          tokenUsage: { last: { inputTokens: 9, outputTokens: 9 } },
        },
      });
      child.send({
        method: "thread/tokenUsage/updated",
        params: {
          threadId: "native-thread",
          tokenUsage: { last: { inputTokens: 9, outputTokens: 9 } },
        },
      });
    };
    stale();
    child.send({
      id: f.requests.find((r) => r.method === "turn/start")!.id,
      result: { turn: { id: "native-turn-1" } },
    });
    await until(() => events.some((event) => event.kind === "turn.started"));
    stale();
    child.send({
      method: "item/completed",
      params: {
        threadId: "native-thread",
        turnId: "native-turn-1",
        item: { id: "new-item", type: "agentMessage", text: "NEW" },
      },
    });
    child.send({
      method: "turn/completed",
      params: { threadId: "native-thread", turn: { id: "native-turn-1", status: "completed" } },
    });
    await send;
    assert.equal(
      events.filter((e) => e.kind === "message.finished" && e.role === "assistant").length,
      1,
    );
    assert.equal(
      events.some(
        (e) => e.kind === "usage.reported" || e.kind === "tool.started" || e.kind === "text.delta",
      ),
      false,
    );
    assert.deepEqual(revoked, ["stale-token"]);
  } finally {
    await adapter.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
