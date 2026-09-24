import assert from "node:assert/strict";
import test from "node:test";
import type { Model, ModelInputMessage, ModelStreamEvent } from "@zcode/contracts";
import { createModelGateway } from "../src/model-gateway/gateway.js";
import { responsesProtocol } from "../src/model-gateway/ingress/responses.js";
import codexFixture from "./fixtures/codexCompatibility0.156.1.fixture.json" with { type: "json" };

function events(body: string): Array<{ type: string; [key: string]: unknown }> {
  return body.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "));
    return data ? [JSON.parse(data.slice(6)) as { type: string }] : [];
  });
}

test("real loopback Responses Gateway executes two fake Model calls with correlated tool-result continuation", async () => {
  const seen: ModelInputMessage[][] = [];
  const model = {
    providerId: "synthetic-provider", modelId: "synthetic-model", options: { reasoningLevel: "off" },
    async *streamText(request: { messages: ModelInputMessage[] }): AsyncIterable<ModelStreamEvent> {
      seen.push(request.messages);
      yield { type: "start" };
      if (seen.length === 1) {
        yield { type: "tool_input_start", id: "call-1", toolName: "read" };
        yield { type: "tool_input_delta", id: "call-1", delta: '{"file":' };
        yield { type: "tool_input_delta", id: "call-1", delta: '"synthetic"}' };
        yield { type: "tool_input_end", id: "call-1" };
        yield { type: "tool_call", toolCall: { id: "call-1", name: "read", input: { file: "synthetic" } } };
        yield { type: "finish", finishReason: "tool-calls", usage: { inputTokens: 10, outputTokens: 5 } };
      } else {
        yield { type: "text_start", id: "text-2" };
        yield { type: "text_delta", id: "text-2", text: "Synthetic result acknowledged" };
        yield { type: "text_end", id: "text-2" };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 20, outputTokens: 4 } };
      }
    },
  } as Model;
  const gateway = createModelGateway({ protocols: [responsesProtocol], resolveModel: () => model, limits: { maxBodyBytes: 256 * 1024, maxConcurrentRequests: 1 } });
  const { url } = await gateway.start();
  try {
    const send = async (turn: string, input: unknown[]) => {
      const token = await gateway.issueToken({ targetId: "synthetic-target", hostSessionId: "synthetic-session", runtimeEpoch: "synthetic-epoch", turnId: turn,
        protocol: "responses", requestedModelAlias: "synthetic-alias", effectiveSelection: { providerId: "synthetic-provider", modelId: "synthetic-model", options: { reasoningLevel: "off" } },
        expiresAt: Date.now() + 30_000, maxRequests: 1, maxOutputBytes: 32 * 1024, maxGenerationTokens: 256, maxOutputTokensPerRequest: 256 });
      const response = await fetch(`${url}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "synthetic-alias", stream: true, input, tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }) });
      const raw = await response.text();
      gateway.revokeToken(token);
      assert.equal(response.status, 200, raw.slice(0, 120));
      return events(raw);
    };
    const first = await send("turn-1", [{ role: "user", content: "read synthetic fixture" }]);
    const call = first.find((event) => event.type === "response.output_item.done")?.item as { call_id: string; arguments: string };
    assert.deepEqual(JSON.parse(call.arguments), { file: "synthetic" });
    assert.equal(call.call_id, "call-1");
    assert.equal(first.at(-1)?.type, "response.completed");
    const second = await send("turn-2", [
      { role: "user", content: "read synthetic fixture" },
      { type: "function_call", call_id: call.call_id, name: "read", arguments: call.arguments },
      { type: "function_call_output", call_id: call.call_id, output: "fixture content" },
    ]);
    assert.equal(second.at(-1)?.type, "response.completed");
    assert.deepEqual(seen[1]?.at(-1), { role: "tool", toolCallId: "call-1", toolName: "read", content: "fixture content" });
    assert.equal(seen.length, 2);

    const pinned = codexFixture.cases.find((entry) => entry.name === "optional-tools-disabled")?.request.body;
    assert.ok(pinned);
    const blockedToken = await gateway.issueToken({ targetId: "synthetic-target", hostSessionId: "synthetic-session", runtimeEpoch: "synthetic-epoch", turnId: "blocked",
      protocol: "responses", requestedModelAlias: pinned.model, effectiveSelection: { providerId: "synthetic-provider", modelId: "synthetic-model", options: { reasoningLevel: "off" } },
      expiresAt: Date.now() + 30_000, maxRequests: 1, maxOutputBytes: 32 * 1024, maxGenerationTokens: 256, maxOutputTokensPerRequest: 256 });
    const blocked = await fetch(`${url}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${blockedToken}`, "content-type": "application/json" }, body: JSON.stringify(pinned) });
    assert.equal(blocked.status, 422);
    assert.equal(seen.length, 2, "pinned Codex developer instructions must not reach Model by demotion/deletion");
    gateway.revokeToken(blockedToken);
  } finally { await gateway.close(); }
});
