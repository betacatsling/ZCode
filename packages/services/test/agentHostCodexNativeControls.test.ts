import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, mkdir, readFile, rm, mkdtemp } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSdkModelAdapter, type CreateAiSdkModelOptions } from "@zcode/adapters";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { CodexHarnessAdapter } from "../src/agent-adapters/codex/codexHarnessAdapter.js";
import { codexTrustedManifest } from "../src/agent-adapters/codex/codexAdapterContract.js";
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
    await mkdir(cwd);
    const denied = join(cwd, "denied.txt");
    const allowed = join(cwd, "allowed.txt");
    const failures: string[] = [];
    const requests: Array<{ phase: string; body: Record<string, unknown> }> = [];
    let phase: "deny" | "allow" | "cancel" | "resume" = "deny";
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
        assert.equal(body.model, phase === "resume" ? "second" : "first");
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
        if (phase === "resume") {
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
            phase === "resume"
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
        lease: {
          ...issuer,
          issue: async (input) => {
            const lease = await issuer.issue(input);
            issued.push(lease.token);
            return lease;
          },
        },
        resolveTurnPlan: async (_spec, previous, turnId) =>
          turnId === "resume"
            ? {
                ...previous,
                requested: {
                  kind: "host-managed",
                  selection: {
                    providerId: "synthetic",
                    modelId: "second",
                    options: { reasoningLevel: "off" },
                  },
                },
                effective: {
                  providerId: "synthetic",
                  modelId: "second",
                  options: { reasoningLevel: "off" },
                },
              }
            : previous,
      });
      const registry = new HarnessRegistry();
      registry.registerTrusted(codexTrustedManifest, () => adapter!);
      const spec = {
        schemaVersion: 1 as const,
        hostSessionId: randomUUID(),
        execution: {
          targetId: "local",
          workspaceIdentity: "isolated-native-control",
          worktreePath: cwd,
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
      assert.deepEqual(
        requests.filter((entry) => entry.phase === "resume").map((entry) => entry.body.model),
        ["second"],
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
