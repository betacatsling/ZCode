import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, mkdir, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSdkModelAdapter, type CreateAiSdkModelOptions } from "@zcode/adapters";
import { createModelGateway } from "../src/model-gateway/gateway.js";
import { responsesProtocol } from "../src/model-gateway/ingress/responses.js";
import { createCodexTransport } from "../src/agent-adapters/codex/codexTransport.js";

const frame = (type: string, fields: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;

async function beforeDeadline(work: Promise<void>, message: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function modelOptions(baseUrl: string): CreateAiSdkModelOptions {
  return {
    providerId: "synthetic-provider",
    modelId: "synthetic-model",
    providerConfig: {
      access: { type: "api-key", apiKey: "isolated-fake-key" },
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
  "installed Codex 0.156.1 joins scoped Gateway, Responses codec and OpenAI Responses SDK with denied native write",
  {
    skip: process.env.ZCODE_CODEX_GATEWAY_JOIN !== "1",
    timeout: 60_000,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-join-"));
    const cwd = join(root, "cwd");
    await mkdir(cwd);
    const forbidden = join(cwd, "must-not-exist");
    const upstreamRequests: Record<string, unknown>[] = [];
    const fakeFailures: string[] = [];
    const gatewayFailures: string[] = [];
    const modelEvents: string[] = [];
    const gatewayFrames: Array<{ event?: string; data: unknown }> = [];
    const command = `touch ${forbidden}`;
    let holdNextRequest = false;
    let pendingUpstream!: () => void;
    const upstreamPending = new Promise<void>((resolve) => {
      pendingUpstream = resolve;
    });
    let upstreamClosed!: () => void;
    const closedUpstream = new Promise<void>((resolve) => {
      upstreamClosed = resolve;
    });
    const fakeUpstream = createServer(async (request, response) => {
      try {
        assert.equal(request.url, "/v1/responses");
        assert.equal(request.method, "POST");
        assert.equal(request.headers.authorization, "Bearer isolated-fake-key");
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
          assert.ok(Buffer.concat(chunks).length < 256 * 1024);
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        upstreamRequests.push(body);
        assert.equal(body.model, "synthetic-model");
        assert.equal(body.stream, true);
        assert.equal(body.max_output_tokens, 2048);
        assert.equal(typeof body.prompt_cache_key, "string");
        if (holdNextRequest) {
          pendingUpstream();
          response.once("close", upstreamClosed);
          return;
        }
        const input = body.input as Array<Record<string, unknown>>;
        assert.ok(
          input.some(
            (item) =>
              item.role === "developer" &&
              JSON.stringify(item.content).includes("<permissions instructions>"),
          ),
        );
        assert.ok(
          input.some(
            (item) =>
              item.role === "developer" &&
              JSON.stringify(item.content).includes("<skills_instructions>"),
          ),
        );
        assert.equal(
          (body.tools as Array<{ type: string; name?: string }>).some(
            (tool) => tool.type === "web_search" || tool.name === "multi_agent_v1",
          ),
          false,
        );
        const first = upstreamRequests.length === 1;
        if (!first) {
          assert.ok(
            input.some((item) => item.type === "function_call" && item.call_id === "native-call"),
          );
          assert.ok(
            input.some(
              (item) => item.type === "function_call_output" && item.call_id === "native-call",
            ),
          );
        }
        const id = `resp_${upstreamRequests.length}`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          frame("response.created", {
            response: { id, model: "synthetic-model", created_at: 1760000000 },
          }),
        );
        if (first) {
          const item = {
            id: "fc_native",
            type: "function_call",
            name: "exec_command",
            call_id: "native-call",
            arguments: JSON.stringify({
              cmd: command,
              sandbox_permissions: "require_escalated",
              justification: "Synthetic denied write",
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
          response.write(
            frame("response.output_item.added", {
              output_index: 0,
              item: { type: "message", id: "msg_done" },
            }),
          );
          response.write(
            frame("response.output_text.delta", {
              item_id: "msg_done",
              output_index: 0,
              content_index: 0,
              delta: "No file was written.",
            }),
          );
          response.write(
            frame("response.output_item.done", {
              output_index: 0,
              item: {
                type: "message",
                id: "msg_done",
                role: "assistant",
                status: "completed",
                content: [{ type: "output_text", text: "No file was written." }],
              },
            }),
          );
        }
        response.end(
          frame("response.completed", {
            response: {
              id,
              usage: {
                input_tokens: first ? 10 : 20,
                output_tokens: first ? 5 : 4,
                total_tokens: first ? 15 : 24,
              },
            },
          }) + "data: [DONE]\n\n",
        );
      } catch (error) {
        fakeFailures.push(error instanceof Error ? error.message : "unknown fake upstream failure");
        response.writeHead(500).end(
          JSON.stringify({
            error: { type: "test_failure", message: "fake upstream invariant failed" },
          }),
        );
      }
    });
    let transport: Awaited<ReturnType<typeof createCodexTransport>> | undefined;
    let gateway: ReturnType<typeof createModelGateway> | undefined;
    try {
      fakeUpstream.listen(0, "127.0.0.1");
      await once(fakeUpstream, "listening");
      const upstream = fakeUpstream.address();
      assert.ok(upstream && typeof upstream !== "string");
      const model = new AiSdkModelAdapter({ retry: { maxAttempts: 1 } }).createModel(
        modelOptions(`http://127.0.0.1:${upstream.port}/v1`),
      );
      const observedModel = new Proxy(model, {
        get(target, property, receiver) {
          if (property !== "streamText") return Reflect.get(target, property, receiver);
          return async function* (request: Parameters<typeof model.streamText>[0]) {
            for await (const event of model.streamText(request)) {
              modelEvents.push(event.type);
              yield event;
            }
          };
        },
      });
      const observedProtocol = {
        ...responsesProtocol,
        async *encode(
          events: Parameters<typeof responsesProtocol.encode>[0],
          context: Parameters<typeof responsesProtocol.encode>[1],
        ) {
          for await (const frame of responsesProtocol.encode(events, context)) {
            gatewayFrames.push(frame);
            yield frame;
          }
        },
      };
      gateway = createModelGateway({
        protocols: [observedProtocol],
        resolveModel: () => observedModel,
        limits: { maxBodyBytes: 256 * 1024, maxConcurrentRequests: 1 },
        observe: (event) => gatewayFailures.push(event.code),
      });
      const { url } = await gateway.start();
      const token = await gateway.issueToken({
        targetId: "isolated-target",
        hostSessionId: randomUUID(),
        runtimeEpoch: randomUUID(),
        turnId: randomUUID(),
        protocol: "responses",
        requestedModelAlias: "fixture-model",
        effectiveSelection: {
          providerId: "synthetic-provider",
          modelId: "synthetic-model",
          options: { reasoningLevel: "off" },
        },
        expiresAt: Date.now() + 55_000,
        maxRequests: 4,
        maxOutputBytes: 512 * 1024,
        maxGenerationTokens: 8192,
        maxOutputTokensPerRequest: 2048,
      });
      const approvals: string[] = [];
      let complete!: (status: string) => void;
      const completed = new Promise<string>((resolve) => {
        complete = resolve;
      });
      const nativeStatuses: string[] = [];
      transport = await createCodexTransport({
        cwd,
        sessionHome: join(root, "home"),
        gatewayUrl: `${url}/v1`,
        gatewayToken: token,
        model: "fixture-model",
        onEvent: (event) => {
          if (event.kind === "approval") {
            approvals.push(event.method);
            void transport?.replyApproval(event.callbackId, "decline");
          } else if (event.method === "turn/completed") {
            const status = (event.params as { turn: { status: string } }).turn.status;
            nativeStatuses.push(status);
            complete(status);
          }
        },
      });
      const thread = await transport.startThread();
      await transport.startTurn(thread, "Attempt the command tool, then report its denial.");
      assert.equal(
        await completed,
        "completed",
        JSON.stringify({
          fakeFailures,
          gatewayFailures,
          modelEvents,
          inputShapes: upstreamRequests.map((body) =>
            (body.input as Array<{ type?: string; role?: string; call_id?: string }>).map(
              (item) => [item.type, item.role, item.call_id],
            ),
          ),
        }),
      );
      assert.equal(upstreamRequests.length, 2, `native requests: ${upstreamRequests.length}`);
      const toolAdded = gatewayFrames.find((frame) => frame.event === "response.output_item.added")
        ?.data as { item: { id: string; call_id: string } };
      const toolDone = gatewayFrames.find((frame) => frame.event === "response.output_item.done")
        ?.data as { item: { id: string; call_id: string; arguments: string } };
      assert.equal(toolAdded.item.id, toolDone.item.id);
      assert.equal(toolDone.item.call_id, "native-call");
      assert.equal(JSON.parse(toolDone.item.arguments).cmd, command);
      const usage = gatewayFrames
        .filter((frame) => frame.event === "response.completed")
        .map((frame) => (frame.data as { response: { usage: unknown } }).response.usage);
      assert.deepEqual(usage, [
        {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
        {
          input_tokens: 20,
          output_tokens: 4,
          total_tokens: 24,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      ]);
      assert.ok(approvals.length > 0, "native command approval must be declined before any write");
      await assert.rejects(access(forbidden));
      holdNextRequest = true;
      const cancelledTurn = await transport.startTurn(
        thread,
        "Synthetic cancellation: wait for the upstream response.",
      );
      await beforeDeadline(upstreamPending, "native cancellation request not received");
      await transport.interruptTurn(thread, cancelledTurn);
      gateway.revokeToken(token);
      await beforeDeadline(closedUpstream, "upstream was not cancelled");
      assert.equal(
        nativeStatuses.filter((status) => status === "completed").length,
        1,
        "interrupted turn cannot complete",
      );
      await assert.rejects(access(forbidden));
    } finally {
      await transport?.close();
      await gateway?.close();
      fakeUpstream.closeAllConnections();
      if (fakeUpstream.listening)
        await new Promise<void>((resolve) => fakeUpstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
