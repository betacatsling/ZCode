import assert from "node:assert/strict";
import test from "node:test";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { Logger } from "@zcode/contracts";
import { resolveAiSdkModelRetryOptions } from "./retry-policy.js";
import { defaultRuntime, type ResolvedAiSdkModel } from "./runner-runtime.js";
import { runStreamText } from "./runner-stream.js";

// The #354 redaction with a Logger: the real AI SDK streamText drives onError on every failed
// attempt; it must reach logger.warn with ids + status/code only and never touch stderr.

const LEAK = "sk-leak";
const REDACTED_KEYS = [
  "code",
  "modelId",
  "providerId",
  "reason",
  "requestId",
  "retryable",
  "statusCode",
];
const FORBIDDEN = [
  LEAK,
  "Bearer",
  "Incorrect API key",
  "responseBody",
  "requestBodyValues",
  "/chat/completions",
  "127.0.0.1",
  "x-upstream-secret",
  "prompt-text",
];

interface Recorded {
  level: string;
  args: unknown[];
}

function recordingLogger(records: Recorded[]): Logger {
  const logger: Logger = {
    debug: (...args) => void records.push({ level: "debug", args }),
    info: (...args) => void records.push({ level: "info", args }),
    warn: (...args) => void records.push({ level: "warn", args }),
    error: (...args) => void records.push({ level: "error", args }),
    child: () => logger,
  };
  return logger;
}

function failingModel(status: number, seen: { requests: number }): ResolvedAiSdkModel {
  const provider = createOpenAICompatible({
    name: "fixture",
    apiKey: `${LEAK}-configured-key`,
    baseURL: `http://127.0.0.1:9/v1?key=${LEAK}-query`,
    fetch: async () => {
      seen.requests += 1;
      return new Response(
        JSON.stringify({
          error: { message: `Incorrect API key provided: ${LEAK}-upstream-echo`, type: "auth" },
        }),
        {
          status,
          headers: { "content-type": "application/json", "x-upstream-secret": `${LEAK}-header` },
        },
      );
    },
  });
  return {
    providerId: "fixture-provider" as never,
    modelId: "fixture-model" as never,
    model: provider.chatModel("fixture-model"),
    providerKind: "openai-compatible",
    properties: {
      contextWindow: 2048,
      inputFormat: { supportsText: true },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsMidConversationSystem: true,
    } as never,
  };
}

async function failStream(status: number, logger: Logger | undefined) {
  const seen = { requests: 0 };
  const resolved = failingModel(status, seen);
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array, ...rest: unknown[]) => {
    stderr.push(String(chunk));
    return write(chunk as never, ...(rest as []));
  }) as typeof process.stderr.write;
  let failure: unknown;
  try {
    for await (const _event of runStreamText({
      env: {},
      ...(logger ? { logger } : {}),
      request: { messages: [{ role: "user", content: "prompt-text" }] } as never,
      resolveModel: () => resolved,
      resolved,
      retry: resolveAiSdkModelRetryOptions(
        { maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, jitter: false },
        {},
      ),
      runtime: defaultRuntime,
      streamIdleTimeoutMs: 5_000,
      modelIoFullRetentionEnabled: false,
    })) {
      // consume
    }
  } catch (error) {
    failure = error;
  } finally {
    process.stderr.write = write;
  }
  assert.ok(failure, `status ${status} fails the stream`);
  return { requests: seen.requests, stderr: stderr.join("") };
}

function streamErrorWarnings(records: Recorded[]) {
  return records.filter(
    (record) => record.level === "warn" && record.args[0] === "model stream error",
  );
}

function assertRedactedWarning(record: Recorded, status: number, retryable: boolean) {
  assert.equal(record.args.length, 2, "message + fields only; no Error argument");
  const fields = record.args[1] as Record<string, unknown>;
  assert.deepEqual(Object.keys(fields).sort(), REDACTED_KEYS);
  assert.equal(fields.providerId, "fixture-provider");
  assert.equal(fields.modelId, "fixture-model");
  assert.equal(typeof fields.requestId, "string");
  assert.equal(fields.statusCode, status);
  assert.match(String(fields.code), /^[a-z_]+$/);
  assert.match(String(fields.reason), /^[a-z_]+$/);
  assert.equal(fields.retryable, retryable);
}

// Error arguments serialize to "{}" by default; expand them so a leaked message would be caught.
function serialize(records: Recorded[]): string {
  return JSON.stringify(records, (_key, value: unknown) =>
    value instanceof Error
      ? { name: value.name, message: value.message, stack: value.stack }
      : value,
  );
}

function assertNothingForbidden(where: string, text: string) {
  for (const forbidden of FORBIDDEN) {
    assert.equal(text.includes(forbidden), false, `${where} must not contain ${forbidden}`);
  }
}

for (const status of [401, 403]) {
  test(`${status}: logger.warn gets one redacted record and stderr stays empty`, async () => {
    const records: Recorded[] = [];
    const { requests, stderr } = await failStream(status, recordingLogger(records));
    assert.equal(requests, 1, "non-retryable: one attempt");
    const warnings = streamErrorWarnings(records);
    assert.equal(warnings.length, 1);
    assertRedactedWarning(warnings[0]!, status, false);
    assertNothingForbidden("logger args", serialize(records));
    assert.equal(stderr, "", "nothing reaches stderr when a logger is supplied");
  });
}

test("500: one redacted logger.warn per failed attempt (retried), nothing on stderr", async () => {
  const records: Recorded[] = [];
  const { requests, stderr } = await failStream(500, recordingLogger(records));
  assert.equal(requests, 2, "maxAttempts 2");
  const warnings = streamErrorWarnings(records);
  assert.equal(warnings.length, 2);
  for (const warning of warnings) assertRedactedWarning(warning, 500, true);
  assert.notEqual(warnings[0]!.args[1], warnings[1]!.args[1]);
  assertNothingForbidden("logger args", serialize(records));
  assert.equal(stderr, "", "nothing reaches stderr when a logger is supplied");
});

test("without a logger the same failure falls back to one redacted stderr line", async () => {
  const { requests, stderr } = await failStream(401, undefined);
  assert.equal(requests, 1);
  const lines = stderr.split("\n").filter((line) => line.includes("model stream error"));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /providerId=fixture-provider modelId=fixture-model requestId=\S+/);
  assert.match(lines[0]!, /statusCode=401 code=[a-z_]+ reason=[a-z_]+ retryable=false/);
  assertNothingForbidden("stderr", stderr);
});
