// Characterization of runStreamText (pre-split behaviour, locked for the step-4 breakup):
// off-peak queue hold (`attempt -= 1`), thinking-signature repair retry and early consumer return.
// In-process fake AI SDK runtime only: no network, no API keys, no model-io files.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { APICallError } from "ai";
import { resolveAiSdkModelRetryOptions } from "./retry-policy.js";
import type { AiSdkModelRuntime, ResolvedAiSdkModel } from "./runner-runtime.js";
import { runStreamText } from "./runner-stream.js";

// ---- in-process fake AI SDK runtime (no network, no keys) ----
interface AttemptScript {
  chunks?: readonly unknown[];
  /** Rejects iterator.next() after the chunks (thrown path, not an SSE error chunk). */
  rejectWith?: unknown;
  /** Never resolves after the chunks (until the attempt is aborted). */
  hang?: boolean;
}

interface FakeCall {
  messages: string;
  signal: AbortSignal | undefined;
  iteratorReturned: boolean;
  consumeStreamCalled: boolean;
}

function fakeRuntime(scripts: readonly AttemptScript[]) {
  const calls: FakeCall[] = [];
  const runtime: AiSdkModelRuntime = {
    generateText: async () => {
      throw new Error("generateText is not used by runStreamText");
    },
    streamText: ((options: { messages?: unknown; abortSignal?: AbortSignal }) => {
      const script = scripts[calls.length] ?? { chunks: [] };
      const call: FakeCall = {
        messages: JSON.stringify(options.messages ?? null),
        signal: options.abortSignal,
        iteratorReturned: false,
        consumeStreamCalled: false,
      };
      calls.push(call);
      const queue = [...(script.chunks ?? [])];
      const iterator: AsyncIterator<unknown> = {
        next: async () => {
          if (queue.length > 0) return { done: false, value: queue.shift() };
          if (script.rejectWith !== undefined) throw script.rejectWith;
          if (script.hang) return new Promise<never>(() => undefined);
          return { done: true, value: undefined };
        },
        return: async () => {
          call.iteratorReturned = true;
          return { done: true, value: undefined };
        },
      };
      return {
        fullStream: { [Symbol.asyncIterator]: () => iterator },
        response: Promise.resolve({ headers: {} }),
        consumeStream: async () => {
          call.consumeStreamCalled = true;
        },
      };
    }) as never,
  };
  return { runtime, calls };
}

const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };
function textChunks(text: string, id = "t1"): unknown[] {
  return [
    { type: "start" },
    { type: "text-start", id },
    { type: "text-delta", id, text },
    { type: "text-end", id },
    { type: "finish", finishReason: "stop", totalUsage: usage },
  ];
}

function apiError(statusCode: number, message: string, headers: Record<string, string> = {}) {
  return new APICallError({
    message,
    url: "http://fake.invalid/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    responseBody: JSON.stringify({ error: { message } }),
  });
}

interface RunOptions {
  scripts: readonly AttemptScript[];
  maxAttempts?: number;
  providerKind?: "openai-compatible" | "anthropic";
  offPeak?: boolean;
  messages?: unknown[];
  preserveProviderStreamBoundaries?: boolean;
  streamIdleTimeoutMs?: number;
  /** Stop consuming after this many yielded events (generator.return()). */
  takeEvents?: number;
}

const dataDir = mkdtempSync(join(tmpdir(), "zcode-runner-stream-"));
after(() => rmSync(dataDir, { recursive: true, force: true }));

async function run(options: RunOptions) {
  const { runtime, calls } = fakeRuntime(options.scripts);
  const statuses: Array<Record<string, unknown>> = [];
  const events: Array<Record<string, unknown>> = [];
  const model = createOpenAICompatible({ name: "fake", baseURL: "http://fake.invalid/v1" });
  const resolved = {
    providerId: "fake-provider",
    modelId: "fake-model",
    model: model.chatModel("fake-model"),
    providerKind: options.providerKind ?? "openai-compatible",
    properties: { contextWindow: 8192, inputFormat: { supportsText: true } },
    ...(options.offPeak ? { accountAccess: { mode: "off-peak" } } : {}),
  } as never as ResolvedAiSdkModel;
  let error: unknown;
  try {
    const stream = runStreamText({
      env: { ZCODE_RUNTIME_ENV: "test", ZCODE_DATA_BASE_DIR: dataDir },
      request: {
        messages: options.messages ?? [{ role: "user", content: "hi" }],
        ...(options.preserveProviderStreamBoundaries
          ? { preserveProviderStreamBoundaries: true }
          : {}),
      } as never,
      resolveModel: () => resolved,
      resolved,
      retry: resolveAiSdkModelRetryOptions(
        { maxAttempts: options.maxAttempts ?? 3, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
        {},
      ),
      runtime,
      statusSink: { publish: (event) => void statuses.push({ ...event }) },
      streamIdleTimeoutMs: options.streamIdleTimeoutMs ?? 5_000,
      modelIoFullRetentionEnabled: false,
    });
    for await (const event of stream) {
      events.push(event as never);
      if (options.takeEvents !== undefined && events.length >= options.takeEvents) break;
    }
  } catch (caught) {
    error = caught;
  }
  const flow = statuses
    .filter((s) => !String(s.type).startsWith("model_first_"))
    .map((s) => `${String(s.type).replace(/^model_/, "")}#${String(s.attempt)}`);
  return { calls, statuses, events, error, flow, types: events.map((e) => e.type) };
}

/** Status events minus timing/ids: what step (4) must keep identical, in order. */
function facts(statuses: ReadonlyArray<Record<string, unknown>>) {
  const keys = [
    "type",
    "attempt",
    "maxAttempts",
    "nextAttempt",
    "delayMs",
    "reason",
    "retryable",
    "errorCode",
    "errorPhase",
    "statusCode",
    "streamOutputCommitted",
  ];
  return statuses
    .filter((s) => /failed|retry|stalled|completed/.test(String(s.type)))
    .map((s) => Object.fromEntries(keys.filter((k) => s[k] !== undefined).map((k) => [k, s[k]])));
}

const PRELUDE_AND_TEXT = ["start", "text_start", "text_delta", "text_end", "finish"];
const queued = () => apiError(429, "queued", { "retry-after": "0" });
const HELD_FLOW = [
  "request_started#1",
  "request_failed#1",
  "retry_scheduled#1",
  "request_started#1",
  "request_failed#1",
  "retry_scheduled#1",
  "request_started#1",
  "request_completed#1",
];
const QUEUED_RETRY = {
  type: "model_retry_scheduled",
  attempt: 1,
  maxAttempts: 1,
  nextAttempt: 2,
  delayMs: 0,
  reason: "offpeak_queued",
  errorCode: "model_rate_limited",
  statusCode: 429,
};

test("off-peak queued 429 (thrown): retried without spending the budget; attempt stays 1", async () => {
  const r = await run({
    maxAttempts: 1,
    offPeak: true,
    scripts: [{ rejectWith: queued() }, { rejectWith: queued() }, { chunks: textChunks("ok") }],
  });
  assert.equal(r.error, undefined);
  assert.equal(r.calls.length, 3, "two queue holds + the answer, with maxAttempts 1");
  assert.deepEqual(r.types, PRELUDE_AND_TEXT);
  assert.deepEqual(r.flow, HELD_FLOW);
  const f = facts(r.statuses);
  assert.deepEqual(f[0], {
    type: "model_request_failed",
    attempt: 1,
    maxAttempts: 1,
    reason: "rate_limited",
    retryable: true,
    errorCode: "model_rate_limited",
    errorPhase: "stream",
    statusCode: 429,
    streamOutputCommitted: false,
  });
  // nextAttempt says 2 although the held retry is published as attempt 1 again (current behaviour).
  assert.deepEqual([f[1], f[3]], [QUEUED_RETRY, QUEUED_RETRY]);
  assert.deepEqual(f[4], {
    type: "model_request_completed",
    attempt: 1,
    maxAttempts: 1,
    streamOutputCommitted: true,
  });
});

test("off-peak queued 429 as SSE error chunk: same hold through the chunk path", async () => {
  const errorChunk = () => ({ chunks: [{ type: "error", error: queued() }] });
  const r = await run({
    maxAttempts: 1,
    offPeak: true,
    scripts: [errorChunk(), errorChunk(), { chunks: textChunks("ok") }],
  });
  assert.equal(r.error, undefined);
  assert.equal(r.calls.length, 3);
  assert.deepEqual(r.types, PRELUDE_AND_TEXT);
  assert.deepEqual(r.flow, HELD_FLOW);
  assert.deepEqual(facts(r.statuses)[1], QUEUED_RETRY);
});

test("429 without off-peak access: no hold, terminal after one call (control)", async () => {
  const r = await run({
    maxAttempts: 1,
    scripts: [{ rejectWith: queued() }, { chunks: textChunks("must not be requested") }],
  });
  assert.equal(r.calls.length, 1);
  assert.equal((r.error as { code?: string }).code, "model_rate_limited");
  assert.deepEqual(r.flow, ["request_started#1", "request_failed#1"]);
  assert.equal(facts(r.statuses)[0]?.retryable, false);
});

const signedHistory = [
  { role: "user", content: "q1" },
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "think",
        providerOptions: { anthropic: { signature: "sig-abc" } },
      },
      { type: "text", text: "a1" },
    ],
  },
  { role: "user", content: "q2" },
];
const signatureRejected = () =>
  apiError(400, "messages.1.content.0: Invalid signature in thinking block");
const REPAIR_FLOW = [
  "request_started#1",
  "request_failed#1",
  "retry_scheduled#1",
  "request_started#2",
  "request_completed#2",
];
const REPAIR_FACTS = [
  {
    type: "model_request_failed",
    attempt: 1,
    maxAttempts: 2,
    reason: "invalid_request",
    retryable: true,
    errorCode: "invalid_model_request",
    errorPhase: "stream",
    statusCode: 400,
    streamOutputCommitted: false,
  },
  {
    type: "model_retry_scheduled",
    attempt: 1,
    maxAttempts: 2,
    nextAttempt: 2,
    delayMs: 0,
    reason: "reasoning_signature_repair",
    errorCode: "invalid_model_request",
    statusCode: 400,
  },
  { type: "model_request_completed", attempt: 2, maxAttempts: 2, streamOutputCommitted: true },
];

for (const [label, first] of [
  ["thrown", { rejectWith: signatureRejected() }],
  ["SSE error chunk", { chunks: [{ type: "error", error: signatureRejected() }] }],
] as const) {
  test(`signature rejection (${label}): one extra attempt with signed reasoning removed`, async () => {
    const r = await run({
      maxAttempts: 1,
      providerKind: "anthropic",
      messages: signedHistory,
      scripts: [first, { chunks: textChunks("ok") }],
    });
    assert.equal(r.error, undefined);
    assert.equal(r.calls.length, 2, "repair attempt is outside the maxAttempts 1 budget");
    assert.deepEqual(r.types, PRELUDE_AND_TEXT);
    assert.deepEqual(r.flow, REPAIR_FLOW);
    assert.deepEqual(facts(r.statuses), REPAIR_FACTS);
    assert.equal(r.calls[0]!.messages.includes("sig-abc"), true);
    assert.equal(r.calls[1]!.messages.includes("sig-abc"), false);
    assert.equal(r.calls[1]!.messages.includes("a1"), true, "visible assistant text is kept");
  });
}

test("signature rejection twice: repair happens once, the second rejection is terminal", async () => {
  const r = await run({
    maxAttempts: 1,
    providerKind: "anthropic",
    messages: signedHistory,
    scripts: [{ rejectWith: signatureRejected() }, { rejectWith: signatureRejected() }],
  });
  assert.equal(r.calls.length, 2);
  assert.equal((r.error as { code?: string }).code, "invalid_model_request");
  assert.deepEqual(r.flow, [
    "request_started#1",
    "request_failed#1",
    "retry_scheduled#1",
    "request_started#2",
    "request_failed#2",
  ]);
  assert.deepEqual(facts(r.statuses).at(-1), { ...REPAIR_FACTS[0], attempt: 2, retryable: false });
});

test("signature rejection on a non-anthropic provider: no repair, terminal", async () => {
  const r = await run({
    maxAttempts: 1,
    messages: signedHistory,
    scripts: [{ rejectWith: signatureRejected() }, { chunks: textChunks("must not be requested") }],
  });
  assert.equal(r.calls.length, 1);
  assert.equal((r.error as { code?: string }).code, "invalid_model_request");
  assert.deepEqual(r.flow, ["request_started#1", "request_failed#1"]);
});

test("early consumer return (plain stream): no further attempt, no terminal status, iterator left open", async () => {
  const r = await run({ takeEvents: 3, scripts: [{ chunks: textChunks("abc") }, {}] });
  assert.equal(r.error, undefined);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.types, ["start", "text_start", "text_delta"]);
  assert.deepEqual(r.flow, ["request_started#1"]);
  const call = r.calls[0]!;
  // Existing semantics: a plain consumer that stops early neither aborts nor closes the attempt.
  assert.deepEqual(
    [call.signal?.aborted, call.iteratorReturned, call.consumeStreamCalled],
    [false, false, false],
  );
});

test("early consumer return (provider stream boundaries): attempt aborted, closed, cancelled status", async () => {
  const r = await run({
    takeEvents: 3,
    preserveProviderStreamBoundaries: true,
    scripts: [{ chunks: textChunks("abc") }, {}],
  });
  await new Promise((resolve) => setImmediate(resolve)); // close is fire-and-forget
  assert.equal(r.error, undefined);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.types, ["start", "text_start", "text_delta"]);
  assert.deepEqual(r.flow, ["request_started#1", "request_failed#1"]);
  assert.deepEqual(facts(r.statuses), [
    {
      type: "model_request_failed",
      attempt: 1,
      maxAttempts: 3,
      reason: "cancelled",
      retryable: false,
      errorCode: "model_request_cancelled",
      errorPhase: "stream",
      streamOutputCommitted: true,
    },
  ]);
  const failed = r.statuses.find((s) => s.type === "model_request_failed");
  assert.equal(failed?.message, "Model stream consumer closed before natural EOF.");
  const call = r.calls[0]!;
  assert.deepEqual(
    [call.signal?.aborted, call.iteratorReturned, call.consumeStreamCalled],
    [true, true, false],
  );
});
