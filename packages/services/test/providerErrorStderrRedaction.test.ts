/**
 * A failing Provider must never put its response body (or anything else carrying key material)
 * on the host's stderr. The AI SDK's default streamText onError console.errors the raw
 * APICallError (responseBody, url, requestBodyValues). The adapter replaces it with one redacted
 * line: provider/model/request ids, statusCode and the classified code/reason/retryable only.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { LEAK_MARKER } from "./fixtures/providerFailureHost.js";

const scenario = fileURLToPath(
  new URL("./fixtures/providerErrorStderrScenario.ts", import.meta.url),
);
const RESULT_PREFIX = "STDERR-SCENARIO-RESULT ";

async function runScenario(status: number) {
  const child = spawn(process.execPath, ["--import", "tsx", scenario, String(status)], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const line = stdout.split("\n").find((entry) => entry.startsWith(RESULT_PREFIX));
  assert.equal(code, 0, `scenario ${status} exited ${code}\n${stderr}`);
  assert.ok(line, `scenario ${status} printed a result`);
  const result = JSON.parse(line.slice(RESULT_PREFIX.length)) as {
    providerId: string;
    requests: number;
    lastErrorCode?: string;
  };
  return { result, stderr };
}

function assertRedacted(stderr: string, providerId: string, status: number, minLines: number) {
  for (const forbidden of [
    LEAK_MARKER,
    "Incorrect API key",
    "responseBody",
    "requestBodyValues",
    "/v1/chat/completions",
    "Bearer",
  ]) {
    assert.equal(stderr.includes(forbidden), false, `stderr must not contain ${forbidden}`);
  }
  // Positive control: a redacted status/code line is still logged for each failed attempt.
  const lines = stderr
    .split("\n")
    .filter((line) => line.includes("model stream error") && line.includes(providerId));
  assert.ok(lines.length >= minLines, `expected a redacted line, stderr was:\n${stderr}`);
  for (const line of lines) {
    assert.match(line, new RegExp(`statusCode=${status}\\b`));
    assert.match(line, /\bcode=[a-z_]+/);
    assert.match(line, /\breason=[a-z_]+/);
    assert.match(line, /\bretryable=(true|false)\b/);
  }
  return lines;
}

for (const status of [401, 403]) {
  test(
    `${status} auth_failed: stderr has a redacted status/code line and no key material`,
    {
      timeout: 60_000,
    },
    async () => {
      const { result, stderr } = await runScenario(status);
      assert.equal(result.lastErrorCode, "provider-reconfigure-required");
      assert.equal(result.requests, 1, "non-retryable: one Provider request");
      const [line] = assertRedacted(stderr, result.providerId, status, 1);
      assert.match(line ?? "", /\bretryable=false\b/);
    },
  );
}

test(
  "500 (retryable): each failed attempt logs a redacted line, never the body",
  {
    timeout: 60_000,
  },
  async () => {
    const { result, stderr } = await runScenario(500);
    assert.equal(result.requests, 2, "retried once with maxAttempts 2");
    const lines = assertRedacted(stderr, result.providerId, 500, 2);
    assert.ok(lines.every((line) => /\bretryable=true\b/.test(line)));
  },
);
