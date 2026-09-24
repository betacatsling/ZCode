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
    const pinnedToken = await gateway.issueToken({ targetId: "synthetic-target", hostSessionId: "synthetic-session", runtimeEpoch: "synthetic-epoch", turnId: "pinned",
      protocol: "responses", requestedModelAlias: pinned.model, effectiveSelection: { providerId: "synthetic-provider", modelId: "synthetic-model", options: { reasoningLevel: "off" } },
      expiresAt: Date.now() + 30_000, maxRequests: 1, maxOutputBytes: 32 * 1024, maxGenerationTokens: 256, maxOutputTokensPerRequest: 256 });
    const pinnedResponse = await fetch(`${url}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${pinnedToken}`, "content-type": "application/json" }, body: JSON.stringify(pinned) });
    assert.equal(pinnedResponse.status, 200);
    await pinnedResponse.text();
    assert.equal(seen.length, 3);
    assert.equal(seen[2]?.[1]?.role, "developer", "pinned Codex instructions must retain their role");
    gateway.revokeToken(pinnedToken);
  } finally { await gateway.close(); }
});

test("Responses private state from a first streamed item rejects on replay before Model, even across routes", async () => {
  const calls: string[] = [];
  const seen: ModelInputMessage[][] = [];
  const makeModel = (providerId: string): Model =>
    ({
      providerId,
      modelId: "synthetic-model",
      options: { reasoningLevel: "off" },
      async *streamText(request: {
        messages: ModelInputMessage[];
      }): AsyncIterable<ModelStreamEvent> {
        calls.push(providerId);
        seen.push(request.messages);
        yield {
          type: "reasoning_start",
          id: "reasoning",
          providerMetadata: {
            openai: {
              itemId: "original-item",
              reasoningEncryptedContent: "opaque-private-fixture",
            },
          },
        };
        yield { type: "reasoning_delta", id: "reasoning", text: "summary" };
        yield { type: "reasoning_end", id: "reasoning" };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 4, outputTokens: 3 } };
      },
    }) as Model;
  const gateway = createModelGateway({
    protocols: [responsesProtocol],
    resolveModel: (binding) => makeModel(binding.effectiveSelection.providerId),
    limits: { maxBodyBytes: 64 * 1024, maxConcurrentRequests: 1 },
  });
  const { url } = await gateway.start();
  const send = async (providerId: string, input: unknown[]) => {
    const token = await gateway.issueToken({
      targetId: "target",
      hostSessionId: "session",
      runtimeEpoch: "epoch",
      turnId: `turn-${providerId}-${calls.length}`,
      protocol: "responses",
      requestedModelAlias: "alias",
      effectiveSelection: {
        providerId,
        modelId: "synthetic-model",
        options: { reasoningLevel: "off" },
      },
      expiresAt: Date.now() + 30_000,
      maxRequests: 1,
      maxOutputBytes: 32 * 1024,
      maxGenerationTokens: 256,
      maxOutputTokensPerRequest: 256,
    });
    try {
      const response = await fetch(`${url}/v1/responses`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "alias",
          stream: true,
          reasoning: { effort: "none" },
          include: ["reasoning.encrypted_content"],
          prompt_cache_key: "cache-stays-independent",
          input,
        }),
      });
      return { status: response.status, body: await response.text() };
    } finally {
      gateway.revokeToken(token);
    }
  };
  try {
    const first = await send("original-route", [
      { role: "developer", content: "remain developer" },
      { role: "user", content: "prompt" },
    ]);
    assert.equal(first.status, 200);
    assert.deepEqual(seen[0], [
      { role: "developer", content: "remain developer" },
      { role: "user", content: "prompt" },
    ]);
    const item = events(first.body).find((event) => event.type === "response.output_item.done")
      ?.item as Record<string, unknown>;
    assert.deepEqual(item, {
      id: "original-item",
      type: "reasoning",
      status: "completed",
      encrypted_content: "opaque-private-fixture",
      summary: [{ type: "summary_text", text: "summary" }],
    });
    for (const route of ["original-route", "changed-route"]) {
      const second = await send(route, [
        item,
        { role: "developer", content: "remain developer" },
        { role: "user", content: "continue" },
      ]);
      assert.equal(second.status, 422);
      assert.deepEqual(JSON.parse(second.body), {
        error: { code: "unsupported_reasoning_replay" },
      });
    }
    assert.deepEqual(calls, ["original-route"], "no second Model call, regardless of bound route");
    const malformed = await send("original-route", [
      { ...item, encrypted_content: 42 },
      { role: "user", content: "continue" },
    ]);
    assert.equal(malformed.status, 422);
    assert.deepEqual(JSON.parse(malformed.body), { error: { code: "unsupported_reasoning" } });
    assert.deepEqual(calls, ["original-route"]);
    // A rejected history does not disable ordinary developer/cache requests for this profile.
    const clean = await send("original-route", [
      { role: "developer", content: "remain developer" },
      { role: "user", content: "next ordinary prompt" },
    ]);
    assert.equal(clean.status, 200);
    assert.equal(events(clean.body).at(-1)?.type, "response.completed");
    assert.deepEqual(seen[1], [
      { role: "developer", content: "remain developer" },
      { role: "user", content: "next ordinary prompt" },
    ]);
  } finally {
    await gateway.close();
  }
});
