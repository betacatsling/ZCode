// Characterization of runStreamText (pre-split behaviour, locked for the step-4 breakup):
// empty-completion retry, SSE error-chunk retry/terminal, thrown-error retry and idle timeout.
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
const zeroUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
function textChunks(text: string, id = "t1"): unknown[] {
  return [
    { type: "start" },
    { type: "text-start", id },
    { type: "text-delta", id, text },
    { type: "text-end", id },
    { type: "finish", finishReason: "stop", totalUsage: usage },
  ];
}
const emptyCompletion = [
  { type: "start" },
  { type: "finish", finishReason: "other", totalUsage: zeroUsage },
];

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

test("empty completion: held, one retry, then the real answer; attempt-1 events never leak", async () => {
  const r = await run({ scripts: [{ chunks: emptyCompletion }, { chunks: textChunks("hello") }] });
  assert.equal(r.error, undefined);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.types, PRELUDE_AND_TEXT);
  assert.equal(r.events.find((e) => e.type === "text_delta")?.text, "hello");
  assert.deepEqual(r.flow, [
    "request_started#1",
    "request_failed#1",
    "retry_scheduled#1",
    "request_started#2",
    "request_completed#2",
  ]);
  assert.deepEqual(facts(r.statuses), [
    {
      type: "model_request_failed",
      attempt: 1,
      maxAttempts: 3,
      reason: "unknown",
      retryable: true,
      errorCode: "invalid_model_response",
      errorPhase: "stream",
      streamOutputCommitted: false,
    },
    {
      type: "model_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      nextAttempt: 2,
      delayMs: 0,
      reason: "server_error",
      errorCode: "invalid_model_response",
    },
    { type: "model_request_completed", attempt: 2, maxAttempts: 3, streamOutputCommitted: true },
  ]);
});

test("empty completion: only one empty retry; the second empty result is yielded and completes", async () => {
  const r = await run({
    scripts: [
      { chunks: emptyCompletion },
      { chunks: emptyCompletion },
      { chunks: textChunks("x") },
    ],
  });
  assert.equal(r.error, undefined);
  assert.equal(r.calls.length, 2, "EMPTY_COMPLETION_MAX_RETRIES = 1 even with maxAttempts 3");
  assert.deepEqual(r.types, ["start", "finish"]);
  assert.deepEqual(r.flow, [
    "request_started#1",
    "request_failed#1",
    "retry_scheduled#1",
    "request_started#2",
    "request_completed#2",
  ]);
  assert.equal(facts(r.statuses).at(-1)?.streamOutputCommitted, false);
});

test("empty completion: no retry when the attempt budget is spent (maxAttempts 1)", async () => {
  const r = await run({ maxAttempts: 1, scripts: [{ chunks: emptyCompletion }] });
  assert.equal(r.error, undefined);
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.types, ["start", "finish"]);
  assert.deepEqual(r.flow, ["request_started#1", "request_completed#1"]);
});

test("SSE error chunk 500 before output: retried; old attempt aborted and closed", async () => {
  const r = await run({
    scripts: [
      { chunks: [{ type: "start" }, { type: "error", error: apiError(500, "boom") }] },
      { chunks: textChunks("ok") },
    ],
  });
  assert.equal(r.error, undefined);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.types, PRELUDE_AND_TEXT);
  assert.deepEqual(r.flow, [
    "request_started#1",
    "request_failed#1",
    "retry_scheduled#1",
    "request_started#2",
    "request_completed#2",
  ]);
  assert.deepEqual(facts(r.statuses).slice(0, 2), [
    {
      type: "model_request_failed",
      attempt: 1,
      maxAttempts: 3,
      reason: "server_error",
      retryable: true,
      errorCode: "model_request_failed",
      errorPhase: "stream",
      statusCode: 500,
      streamOutputCommitted: false,
    },
    {
      type: "model_retry_scheduled",
      attempt: 1,
      maxAttempts: 3,
      nextAttempt: 2,
      delayMs: 0,
      reason: "server_error",
      errorCode: "model_request_failed",
      statusCode: 500,
    },
  ]);
  const [first, second] = r.calls;
  assert.deepEqual(
    [first!.signal?.aborted, first!.iteratorReturned, first!.consumeStreamCalled],
    [true, true, true],
  );
  assert.deepEqual([second!.signal?.aborted, second!.iteratorReturned], [false, false]);
});

test("SSE error chunk 400: terminal, one call, typed adapter error", async () => {
  const r = await run({
    scripts: [{ chunks: [{ type: "start" }, { type: "error", error: apiError(400, "bad") }] }],
  });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.types, []);
  assert.equal((r.error as { code?: string }).code, "invalid_model_request");
  assert.deepEqual(r.flow, ["request_started#1", "request_failed#1"]);
  assert.equal(facts(r.statuses)[0]?.retryable, false);
});

test("SSE error chunk 500 after visible text: no replay; text stays yielded, then terminal", async () => {
  const r = await run({
    scripts: [
      {
        chunks: [
          ...textChunks("partial").slice(0, 3),
          { type: "error", error: apiError(500, "x") },
        ],
      },
      { chunks: textChunks("must not be requested") },
    ],
  });
  assert.equal(r.calls.length, 1);
  assert.deepEqual(r.types, ["start", "text_start", "text_delta"]);
  assert.equal((r.error as { code?: string }).code, "model_request_failed");
  assert.deepEqual(r.flow, ["request_started#1", "request_failed#1"]);
  assert.deepEqual(
    [facts(r.statuses)[0]?.retryable, facts(r.statuses)[0]?.streamOutputCommitted],
    [false, true],
  );
});

test("thrown 503 from the stream (catch path): retried like the error chunk", async () => {
  const r = await run({
    scripts: [
      { chunks: [{ type: "start" }], rejectWith: apiError(503, "unavailable") },
      { chunks: textChunks("ok") },
    ],
  });
  assert.equal(r.error, undefined);
  assert.equal(r.calls.length, 2);
  assert.deepEqual(r.types, PRELUDE_AND_TEXT);
  assert.deepEqual(r.flow, [
    "request_started#1",
    "request_failed#1",
    "retry_scheduled#1",
    "request_started#2",
    "request_completed#2",
  ]);
  assert.deepEqual(
    facts(r.statuses).map((f) => f.statusCode),
    [503, 503, undefined],
  );
  assert.deepEqual([r.calls[0]!.signal?.aborted, r.calls[0]!.iteratorReturned], [true, true]);
});

test(
  "idle timeout: stalled status, attempt aborted with the idle error, retried",
  { timeout: 10_000 },
  async () => {
    const r = await run({
      streamIdleTimeoutMs: 40,
      scripts: [{ chunks: [{ type: "start" }], hang: true }, { chunks: textChunks("ok") }],
    });
    assert.equal(r.error, undefined);
    assert.equal(r.calls.length, 2);
    assert.deepEqual(r.types, PRELUDE_AND_TEXT);
    assert.deepEqual(r.flow, [
      "request_started#1",
      "stream_stalled#1",
      "request_failed#1",
      "retry_scheduled#1",
      "request_started#2",
      "request_completed#2",
    ]);
    const stalled = r.statuses.find((s) => s.type === "model_stream_stalled");
    assert.equal(stalled?.timeoutMs, 40);
    assert.deepEqual(facts(r.statuses).slice(1, 3), [
      {
        type: "model_request_failed",
        attempt: 1,
        maxAttempts: 3,
        reason: "stream_idle_timeout",
        retryable: true,
        errorCode: "model_request_timeout",
        errorPhase: "stream",
        streamOutputCommitted: false,
      },
      {
        type: "model_retry_scheduled",
        attempt: 1,
        maxAttempts: 3,
        nextAttempt: 2,
        delayMs: 0,
        reason: "stream_idle_timeout",
        errorCode: "model_request_timeout",
      },
    ]);
    const first = r.calls[0]!;
    assert.equal(first.signal?.aborted, true);
    assert.equal((first.signal?.reason as Error | undefined)?.name, "ModelStreamIdleTimeoutError");
    assert.equal(first.iteratorReturned, true);
  },
);
