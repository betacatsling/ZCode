import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, realpath, rm, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSdkModelAdapter, type CreateAiSdkModelOptions } from "@zcode/adapters";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { CodexHarnessAdapter } from "../src/agent-adapters/codex/codexHarnessAdapter.js";
import { codexTrustedManifest } from "../src/agent-adapters/codex/codexAdapterContract.js";
import { codexSessionProfile } from "../src/agent-adapters/codex/codexBinding.js";
import { createCodexGatewayLeaseIssuer } from "../src/agent-adapters/codex/createCodexGatewayLeaseIssuer.js";
import { createModelGateway } from "../src/model-gateway/gateway.js";
import { responsesProtocol } from "../src/model-gateway/ingress/responses.js";

const frame = (type: string, fields: object) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function beforeDeadline(work: Promise<void>, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 9000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
async function waitFor(check: () => boolean, detail: () => unknown) {
  const end = Date.now() + 9000;
  while (!check() && Date.now() < end) await sleep(20);
  assert.ok(check(), JSON.stringify(detail()));
}
function modelOptions(modelId: string, baseUrl: string): CreateAiSdkModelOptions {
  return {
    providerId: "synthetic",
    modelId,
    providerConfig: {
      access: { type: "api-key", apiKey: "fake-local-key" },
      api: { type: "openai-responses", baseUrl },
    } as CreateAiSdkModelOptions["providerConfig"],
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
    } as CreateAiSdkModelOptions["modelConfig"],
    options: { reasoningLevel: "off", maxOutputTokens: 2048 },
  };
}

test(
  "pinned CLI → adapter → Host → Gateway → SDK: native denial, allowance, cancellation, resume/model lease",
  {
    skip: process.env.ZCODE_CODEX_ADAPTER_JOIN !== "1",
    timeout: 120_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-host-native-"));
    const cwd = join(root, "worktree");
    const subdir = join(cwd, "sub");
    await mkdir(subdir, { recursive: true });
    const denied = join(subdir, "denied.txt");
    const allowed = join(subdir, "allowed.txt");
    const nativeCwds: string[] = [];
    const nativeFrames: Array<{ method: string; hasTurnId: boolean; completionId: boolean }> = [];
    const nativeChildren: ReturnType<typeof spawn>[] = [];
    const firstTurnFrames = new Map<string, Buffer>();
    const failures: string[] = [];
    const requests: Array<{ phase: string; body: Record<string, unknown> }> = [];
    let phase: "deny" | "allow" | "cancel" | "resume" | "reopened" = "deny";
    let cancelArrived!: () => void;
    const pendingCancel = new Promise<void>((resolve) => {
      cancelArrived = resolve;
    });
    let cancelClosed!: () => void;
    const closedCancel = new Promise<void>((resolve) => {
      cancelClosed = resolve;
    });
    const upstream = createServer(async (request, response) => {
      try {
        assert.equal(request.url, "/v1/responses");
        assert.equal(request.headers.authorization, "Bearer fake-local-key");
        let raw = "";
        for await (const chunk of request) {
          raw += String(chunk);
          assert.ok(raw.length < 256_000);
        }
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push({ phase, body });
        assert.equal(body.model, "first");
        const input = body.input as Array<Record<string, unknown>>;
        assert.ok(
          input.some(
            (item) =>
              item.role === "developer" &&
              JSON.stringify(item.content).includes("<permissions instructions>"),
          ),
        );
        if (phase === "cancel") {
          cancelArrived();
          response.once("close", cancelClosed);
          return;
        }
        if (phase === "resume" || phase === "reopened") {
          assert.ok(
            JSON.stringify(input).includes("allowed.txt"),
            "native resumed thread retains prior tool context",
          );
        }
        const callOutput = input.find(
          (item) => item.type === "function_call_output" && item.call_id === `call-${phase}`,
        );
        const id = `resp-${requests.length}`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          frame("response.created", {
            response: { id, model: body.model, created_at: 1760000000 },
          }),
        );
        if ((phase === "deny" || phase === "allow") && !callOutput) {
          const target = phase === "deny" ? denied : allowed;
          const item = {
            id: `fc-${phase}`,
            type: "function_call",
            name: "exec_command",
            call_id: `call-${phase}`,
            arguments: JSON.stringify({
              cmd: `touch ${target}`,
              sandbox_permissions: "require_escalated",
              justification: "Isolated native control proof",
            }),
            status: "completed",
          };
          response.write(frame("response.output_item.added", { output_index: 0, item }));
          response.write(
            frame("response.function_call_arguments.delta", {
              item_id: item.id,
              output_index: 0,
              delta: item.arguments,
            }),
          );
          response.write(
            frame("response.function_call_arguments.done", {
              item_id: item.id,
              output_index: 0,
              arguments: item.arguments,
            }),
          );
          response.write(frame("response.output_item.done", { output_index: 0, item }));
        } else {
          const text =
            phase === "reopened"
              ? "Reopened thread continued."
              : phase === "resume"
                ? "Second model resumed."
                : phase === "deny"
                  ? "Denied safely."
                  : "Native command completed.";
          const item = {
            id: `msg-${phase}`,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text }],
          };
          response.write(
            frame("response.output_item.added", {
              output_index: 0,
              item: { type: "message", id: item.id },
            }),
          );
          response.write(
            frame("response.output_text.delta", {
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: text,
            }),
          );
          response.write(frame("response.output_item.done", { output_index: 0, item }));
        }
        response.end(
          frame("response.completed", {
            response: { id, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } },
          }) + "data: [DONE]\n\n",
        );
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
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
      const models = new Map(
        ["first", "second"].map((id) => [
          id,
          new AiSdkModelAdapter({ retry: { maxAttempts: 1 } }).createModel(
            modelOptions(id, `http://127.0.0.1:${address.port}/v1`),
          ),
        ]),
      );
      gateway = createModelGateway({
        protocols: [responsesProtocol],
        resolveModel: (binding) => models.get(binding.effectiveSelection.modelId)!,
        limits: { maxBodyBytes: 256_000, maxConcurrentRequests: 2 },
      });
      const { url } = await gateway.start();
      const issued: string[] = [];
      const issuer = createCodexGatewayLeaseIssuer({ gateway, gatewayUrl: `${url}/v1` });
      adapter = new CodexHarnessAdapter({
        root: join(root, "profiles"),
        spawnProcess: ((command, args, options) => {
          const child = spawn(command, args, options);
          if (args[0] !== "--version") {
            nativeCwds.push(options.cwd ?? "");
            nativeChildren.push(child);
            let tail = "";
            child.stdout.on("data", (chunk: Buffer) => {
              tail += chunk.toString("utf8");
              // Test-only observation of actual pinned CLI bytes; no synthetic native IDs.
              while (tail.includes("\n")) {
                const index = tail.indexOf("\n");
                const line = tail.slice(0, index);
                tail = tail.slice(index + 1);
                try {
                  const frame = JSON.parse(line) as {
                    method?: string;
                    params?: {
                      turnId?: unknown;
                      turn?: { id?: unknown };
                      item?: { type?: unknown };
                    };
                  };
                  if (frame.method) {
                    const oldFamily = [
                      "turn/completed",
                      "item/started",
                      "item/completed",
                      "item/agentMessage/delta",
                      "thread/tokenUsage/updated",
                    ];
                    if (
                      nativeChildren.length === 1 &&
                      oldFamily.includes(frame.method) &&
                      !firstTurnFrames.has(frame.method) &&
                      Buffer.byteLength(line) < 1024 * 1024
                    )
                      firstTurnFrames.set(frame.method, Buffer.from(`${line}\n`));
                    if (
                      nativeChildren.length === 1 &&
                      frame.method === "item/completed" &&
                      frame.params?.item?.type === "commandExecution" &&
                      !firstTurnFrames.has("native-tool") &&
                      Buffer.byteLength(line) < 1024 * 1024
                    )
                      firstTurnFrames.set("native-tool", Buffer.from(`${line}\n`));
                    nativeFrames.push({
                      method: frame.method,
                      hasTurnId: typeof frame.params?.turnId === "string",
                      completionId: typeof frame.params?.turn?.id === "string",
                    });
                  }
                } catch {
                  /* Transport owns malformed-frame rejection. */
                }
              }
            });
          }
          return child;
        }) as typeof spawn,
        lease: {
          ...issuer,
          issue: async (input) => {
            const lease = await issuer.issue(input);
            issued.push(lease.token);
            return lease;
          },
        },
      });
      const registry = new HarnessRegistry();
      registry.registerTrusted(codexTrustedManifest, () => adapter!);
      const spec = {
        schemaVersion: 2 as const,
        projectId: "project",
        workspaceId: "workspace",
        hostSessionId: randomUUID(),
        execution: {
          targetId: "local",
          workspaceIdentity: "isolated-native-control",
          worktreePath: cwd,
          worktreeGeneration: "generation",
          cwdRelativeToWorktree: "sub",
        },
        harness: { id: "codex", adapterVersion: "0.156.1" },
        modelBinding: {
          kind: "host-managed" as const,
          selection: {
            providerId: "synthetic",
            modelId: "first",
            options: { reasoningLevel: "off" as const },
          },
        },
      };
      host = await SessionHost.create({
        root: join(root, "journals"),
        spec,
        target: {
          id: "local",
          kind: "local",
          platform: process.platform as "darwin" | "linux",
          available: true,
        },
        registry,
        catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true }) },
      });
      const current = host;
      async function send(turnId: string) {
        const receipt = await current.dispatch({
          type: "send",
          commandId: `send-${turnId}`,
          hostSessionId: spec.hostSessionId,
          turnId,
          text: `Native ${turnId} control test`,
        });
        assert.equal(receipt.status, "accepted");
      }
      async function approval(turnId: string, decision: "allow" | "deny") {
        await waitFor(
          () =>
            current
              .eventsSince(0)
              .some((event) => event.kind === "interaction.requested" && event.turnId === turnId),
          () => ({ failures, phase, events: current.eventsSince(0).map((event) => event.kind) }),
        );
        const requested = current
          .eventsSince(0)
          .find((event) => event.kind === "interaction.requested" && event.turnId === turnId)!;
        assert.equal(
          current
            .snapshot()
            .pendingInteractions.some((entry) => entry.interactionId === requested.interactionId),
          true,
        );
        if (turnId === "allow") {
          // Reinject bounded, verbatim bytes emitted by the previous pinned CLI turn.
          // No fabricated turn IDs; the newer live child must not project old item/usage.
          for (const method of [
            "item/started",
            "item/completed",
            "item/agentMessage/delta",
            "thread/tokenUsage/updated",
          ])
            if (firstTurnFrames.has(method))
              nativeChildren.at(-1)!.stdout.emit("data", firstTurnFrames.get(method)!);
          assert.ok(firstTurnFrames.has("item/completed"));
          assert.ok(firstTurnFrames.has("thread/tokenUsage/updated"));
        }
        const stale = await current.dispatch({
          type: "resolveInteraction",
          commandId: `stale-${turnId}`,
          hostSessionId: spec.hostSessionId,
          runtimeEpoch: "stale-epoch",
          turnId,
          interactionId: requested.interactionId,
          decision: "allow",
        });
        assert.equal(stale.status, "rejected");
        assert.equal(current.snapshot().pendingInteractions.length, 1);
        const receipt = await current.dispatch({
          type: "resolveInteraction",
          commandId: `resolve-${turnId}`,
          hostSessionId: spec.hostSessionId,
          runtimeEpoch: current.binding.runtimeEpoch,
          turnId,
          interactionId: requested.interactionId,
          decision,
        });
        assert.equal(receipt.status, "completed", JSON.stringify(receipt));
        await current.whenIdle();
        assert.equal(current.queryCommand(`send-${turnId}`)?.status, "completed");
        assert.equal(
          current
            .eventsSince(0)
            .some(
              (event) =>
                event.kind === "interaction.resolved" &&
                event.turnId === turnId &&
                event.decision === decision,
            ),
          true,
        );
        assert.equal(
          current
            .eventsSince(0)
            .some((event) => event.kind === "tool.finished" && event.turnId === turnId),
          true,
        );
        assert.equal(current.snapshot().pendingInteractions.length, 0);
        assert.equal(
          current
            .snapshot()
            .rows.window.some(
              (row) =>
                row.kind === "toolCall" &&
                row.turnId === turnId &&
                row.status === (decision === "deny" ? "error" : "success"),
            ),
          true,
        );
        assert.equal(
          current
            .snapshot()
            .rows.window.some(
              (row) =>
                row.kind === "userInput" &&
                row.turnId === turnId &&
                row.text === `Native ${turnId} control test`,
            ),
          true,
        );
      }
      await send("deny");
      await approval("deny", "deny");
      await assert.rejects(access(denied));
      assert.equal(
        current
          .snapshot()
          .rows.window.some((row) => row.kind === "assistantText" && row.text === "Denied safely."),
        true,
      );
      phase = "allow";
      await send("allow");
      await approval("allow", "allow");
      assert.equal(await readFile(allowed, "utf8"), "");
      assert.equal(
        current
          .eventsSince(0)
          .some(
            (event) =>
              event.turnId === "allow" &&
              event.kind === "text.delta" &&
              event.text.includes("Denied safely."),
          ),
        false,
        "verbatim previous-turn native text must not enter the next Host turn",
      );
      assert.equal(
        current
          .snapshot()
          .rows.window.some(
            (row) => row.kind === "assistantText" && row.text === "Native command completed.",
          ),
        true,
      );
      phase = "cancel";
      await send("cancel");
      await beforeDeadline(pendingCancel, "native cancel request not received");
      const cancelled = await current.dispatch({
        type: "cancelTurn",
        commandId: "cancel-active",
        hostSessionId: spec.hostSessionId,
        runtimeEpoch: current.binding.runtimeEpoch,
        turnId: "cancel",
      });
      assert.equal(cancelled.status, "completed", JSON.stringify(cancelled));
      await current.whenIdle();
      await beforeDeadline(closedCancel, "upstream cancel not closed");
      assert.equal(
        current
          .eventsSince(0)
          .some(
            (event) =>
              event.kind === "turn.finished" &&
              event.turnId === "cancel" &&
              event.outcome === "success",
          ),
        false,
      );
      assert.equal(
        current
          .eventsSince(0)
          .some(
            (event) =>
              event.kind === "turn.finished" &&
              event.turnId === "cancel" &&
              event.outcome === "cancelled",
          ),
        true,
      );
      phase = "resume";
      await send("resume");
      const stale = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${issued[0]}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "stale", stream: true, input: [] }),
      });
      assert.equal(stale.status, 401);
      await current.whenIdle();
      assert.deepEqual(
        current
          .eventsSince(0)
          .filter((event) => event.kind === "turn.finished")
          .map((event) => event.outcome),
        ["success", "success", "cancelled", "success"],
      );
      assert.deepEqual(issued.length, 4);
      assert.deepEqual(nativeCwds, Array(4).fill(await realpath(subdir)));
      // Metadata-only inventory; thread-only usage is not attributed to a turn by this test.
      const families = [...new Set(nativeFrames.map((entry) => entry.method))]
        .sort()
        .map((method) => ({
          method,
          explicitTurnIds: nativeFrames.filter(
            (entry) => entry.method === method && entry.hasTurnId,
          ).length,
          nestedCompletionIds: nativeFrames.filter(
            (entry) => entry.method === method && entry.completionId,
          ).length,
          total: nativeFrames.filter((entry) => entry.method === method).length,
        }));
      assert.ok(
        families.some(
          (entry) => entry.method === "turn/completed" && entry.nestedCompletionIds > 0,
        ),
      );
      console.info("CODEX_PINNED_NATIVE_FRAME_FAMILIES", JSON.stringify(families));
      assert.deepEqual(
        requests.filter((entry) => entry.phase === "resume").map((entry) => entry.body.model),
        ["first"],
      );
      assert.equal(
        current
          .snapshot()
          .rows.window.some(
            (row) => row.kind === "assistantText" && row.text === "Second model resumed.",
          ),
        true,
      );
      assert.deepEqual(failures, []);
      await current.close();
      host = undefined;
      await adapter.shutdown();
      // 修复：独立 Host/adapter 重启必须实际执行下一轮，而非仅恢复 Host 快照。
      const originalThreadId = await readFile(
        join(
          codexSessionProfile(join(root, "profiles"), spec),
          `${current.binding.backendSessionId}.thread`,
        ),
        "utf8",
      );
      const reopenedNativeRequests: Array<{
        method: string;
        params?: { threadId?: string; input?: unknown };
      }> = [];
      const reopenedRevoked: string[] = [];
      const reopenedIssued: string[] = [];
      let ackHeld = false;
      let releaseAck: (() => void) | undefined;
      let releaseOldFrames: ((frame: Buffer) => void) | undefined;
      let interceptedBytes = 0;
      let proxyChild: ReturnType<typeof spawn> | undefined;
      const resumedAdapter = new CodexHarnessAdapter({
        root: join(root, "profiles"),
        lease: {
          ...issuer,
          gateway: {
            ...issuer.gateway,
            revokeToken: (token: string) => {
              reopenedRevoked.push(token);
              issuer.gateway.revokeToken(token);
            },
          },
          issue: async (input) => {
            const lease = await issuer.issue(input);
            reopenedIssued.push(lease.token);
            return lease;
          },
        },
        spawnProcess: ((command, args, options) => {
          const child = spawn(command, args, options);
          if (args[0] !== "--version") {
            nativeCwds.push(options.cwd ?? "");
            proxyChild = child;
            let startRequestId: number | undefined;
            let proxyReleased = false;
            let tail = Buffer.alloc(0);
            const delayed: Buffer[] = [];
            const forward = child.stdout.emit.bind(child.stdout);
            releaseOldFrames = (frame) => {
              forward("data", frame);
            };
            // Test-only bounded stdout proxy: real CLI bytes, not fabricated JSON-RPC identities.
            child.stdout.emit = ((event: string, ...args: unknown[]) => {
              if (event !== "data") return forward(event, ...args);
              tail = Buffer.concat([tail, args[0] as Buffer]);
              assert.ok(tail.length + interceptedBytes < 1024 * 1024, "proxy byte limit");
              for (let end; (end = tail.indexOf(10)) >= 0; ) {
                const line = tail.subarray(0, end + 1);
                tail = tail.subarray(end + 1);
                const parsed = JSON.parse(line.toString("utf8")) as {
                  id?: number;
                  result?: { turn?: { id?: string } };
                };
                if (
                  !proxyReleased &&
                  (ackHeld ||
                    (startRequestId !== undefined &&
                      parsed.id === startRequestId &&
                      parsed.result?.turn?.id))
                ) {
                  ackHeld = true;
                  interceptedBytes += line.length;
                  assert.ok(interceptedBytes < 1024 * 1024, "proxy delayed byte limit");
                  delayed.push(Buffer.from(line));
                  releaseAck ??= () => {
                    proxyReleased = true;
                    for (const held of delayed) forward("data", held);
                    delayed.length = 0;
                    interceptedBytes = 0;
                  };
                } else forward("data", line);
              }
              return true;
            }) as typeof child.stdout.emit;
            const write = child.stdin.write.bind(child.stdin);
            child.stdin.write = ((data: string | Buffer, ...rest: unknown[]) => {
              const raw = String(data);
              assert.ok(Buffer.byteLength(raw) < 1024 * 1024);
              for (const line of raw.trimEnd().split("\n")) {
                const request = JSON.parse(line) as {
                  method?: string;
                  params?: { threadId?: string; input?: unknown };
                };
                if (request.method === "turn/start")
                  startRequestId = (request as { id?: number }).id;
                if (
                  request.method === "thread/start" ||
                  request.method === "thread/resume" ||
                  request.method === "turn/start"
                )
                  reopenedNativeRequests.push({ method: request.method, params: request.params });
              }
              return (write as (...args: unknown[]) => boolean)(data, ...rest);
            }) as typeof child.stdin.write;
          }
          return child;
        }) as typeof spawn,
      });
      adapter = resumedAdapter;
      const resumedRegistry = new HarnessRegistry();
      resumedRegistry.registerTrusted(codexTrustedManifest, () => resumedAdapter);
      const reopened = await SessionHost.open({
        root: join(root, "journals"),
        spec,
        target: {
          id: "local",
          kind: "local",
          platform: process.platform as "darwin" | "linux",
          available: true,
        },
        registry: resumedRegistry,
        catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true }) },
      });
      assert.deepEqual(reopened.snapshot().rows.window, current.snapshot().rows.window);
      phase = "reopened";
      const beforeReopenRequestCount = requests.length;
      const reopenedReceipt = await reopened.dispatch({
        type: "send",
        commandId: "send-after-independent-reopen",
        hostSessionId: spec.hostSessionId,
        turnId: "after-reopen",
        text: "Native after-reopen control test",
      });
      assert.equal(reopenedReceipt.status, "accepted", JSON.stringify(reopenedReceipt));
      await waitFor(
        () => ackHeld,
        () => ({ phase, requests: reopenedNativeRequests }),
      );
      assert.ok(proxyChild);
      await reopened.whenEventsRecorded();
      const beforeOldInjection = reopened
        .eventsSince(0)
        .filter((event) => event.turnId === "after-reopen");
      for (const method of [
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "native-tool",
        "thread/tokenUsage/updated",
        "turn/completed",
      ]) {
        const old = firstTurnFrames.get(method);
        assert.ok(old, `pinned CLI did not emit ${method}`);
        // Feed genuine captured bytes before the withheld newer start ACK.
        releaseOldFrames!(old);
      }
      await reopened.whenEventsRecorded();
      assert.deepEqual(
        reopened.eventsSince(0).filter((event) => event.turnId === "after-reopen"),
        beforeOldInjection,
        "none of the genuine previous-turn item, text, tool, usage or completion frames may project",
      );
      assert.equal(reopened.queryCommand("send-after-independent-reopen")?.status, "accepted");
      assert.deepEqual(reopenedRevoked, [], "old completion cannot revoke the current lease");
      assert.equal(reopenedIssued.length, 1);
      assert.equal(
        reopened
          .eventsSince(0)
          .some((event) => event.turnId === "after-reopen" && event.kind === "turn.finished"),
        false,
        "old completion cannot settle the new turn before ACK",
      );
      assert.equal(
        reopened
          .eventsSince(0)
          .some(
            (event) =>
              event.turnId === "after-reopen" &&
              event.kind === "text.delta" &&
              event.text.includes("Denied safely."),
          ),
        false,
        "old native text must not project",
      );
      assert.ok(releaseAck, "actual pinned start ACK must be held");
      releaseAck();
      await reopened.whenIdle();
      assert.deepEqual(reopenedRevoked, reopenedIssued);
      assert.equal(
        reopened
          .eventsSince(0)
          .filter((event) => event.kind === "turn.finished" && event.turnId === "after-reopen")
          .length,
        1,
      );
      assert.equal(reopened.queryCommand("send-after-independent-reopen")?.status, "completed");
      assert.equal(
        requests.length,
        beforeReopenRequestCount + 1,
        "exactly one new upstream effect",
      );
      assert.deepEqual(
        reopenedNativeRequests.filter((request) => request.method === "thread/start"),
        [],
      );
      assert.deepEqual(
        reopenedNativeRequests
          .filter((request) => request.method === "thread/resume")
          .map((request) => request.params?.threadId),
        [originalThreadId],
      );
      assert.deepEqual(
        reopenedNativeRequests
          .filter((request) => request.method === "turn/start")
          .map((request) => [request.params?.threadId, request.params?.input]),
        [[originalThreadId, [{ type: "text", text: "Native after-reopen control test" }]]],
      );
      assert.equal(nativeCwds.at(-1), await realpath(subdir));
      assert.equal(
        reopened
          .snapshot()
          .rows.window.some(
            (row) => row.kind === "assistantText" && row.text === "Reopened thread continued.",
          ),
        true,
      );
      await reopened.close();
      // 修复：已提交 Host 历史不能成为遗失 native thread 的重建许可。
      await rm(
        join(
          codexSessionProfile(join(root, "profiles"), spec),
          `${reopened.binding.backendSessionId}.thread`,
        ),
      );
      const lostAdapter = new CodexHarnessAdapter({ root: join(root, "profiles"), lease: issuer });
      const lostRegistry = new HarnessRegistry();
      lostRegistry.registerTrusted(codexTrustedManifest, () => lostAdapter);
      await assert.rejects(
        SessionHost.open({
          root: join(root, "journals"),
          spec,
          target: {
            id: "local",
            kind: "local",
            platform: process.platform as "darwin" | "linux",
            available: true,
          },
          registry: lostRegistry,
          catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true }) },
        }),
        /native ownership unknown/,
      );
      await lostAdapter.shutdown();
      const history = await SessionHost.snapshotHistory(join(root, "journals"), spec);
      assert.equal(
        history.rows.window.some(
          (row) => row.kind === "assistantText" && row.text === "Second model resumed.",
        ),
        true,
      );
    } finally {
      await host?.close();
      await adapter?.shutdown();
      await gateway?.close();
      upstream.closeAllConnections();
      if (upstream.listening) await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
