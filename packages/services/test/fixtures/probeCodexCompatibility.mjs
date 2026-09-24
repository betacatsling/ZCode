// Explicit opt-in: isolated Codex 0.156.1 → synthetic loopback Responses, no paid API calls.
// ZCODE_CODEX_COMPAT_PROBE=1 node packages/services/test/fixtures/probeCodexCompatibility.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.ZCODE_CODEX_COMPAT_PROBE !== "1")
  throw new Error("explicit synthetic probe opt-in required");
const version = await new Promise((resolve, reject) => {
  const child = spawn("codex", ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
  let output = "";
  child.stdout.on("data", (part) => {
    output += part.toString();
  });
  child.once("error", reject);
  child.once("exit", (code) =>
    code === 0 ? resolve(output.trim()) : reject(new Error("CLI version probe failed")),
  );
});
assert.equal(version, "codex-cli 0.156.1");

const cases = [
  { name: "default", overrides: [], thread: {} },
  {
    name: "optional-tools-disabled",
    overrides: ['web_search="disabled"', "features.multi_agent=false"],
    thread: {},
  },
  {
    name: "empty-instruction-overrides",
    overrides: ['web_search="disabled"', "features.multi_agent=false"],
    thread: { baseInstructions: "", developerInstructions: "" },
  },
  {
    name: "custom-base",
    overrides: ['web_search="disabled"', "features.multi_agent=false"],
    thread: { baseInstructions: "Synthetic base marker. Do not execute tools." },
  },
  {
    name: "custom-developer",
    overrides: ['web_search="disabled"', "features.multi_agent=false"],
    thread: { developerInstructions: "Synthetic developer marker. Do not execute tools." },
  },
  {
    name: "skip-host-skills",
    overrides: [
      'web_search="disabled"',
      "features.multi_agent=false",
      "features.skill_search=false",
      "features.skip_host_skill_discovery=true",
    ],
    thread: { baseInstructions: "", developerInstructions: "" },
  },
];

async function runCase(spec) {
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-compat-"));
  const home = join(root, "home");
  await mkdir(home);
  const requests = [];
  const server = createServer(async (request, response) => {
    let body = "";
    try {
      if (request.method !== "POST" || request.url !== "/v1/responses")
        throw new Error("unexpected endpoint");
      for await (const chunk of request) {
        body += String(chunk);
        if (Buffer.byteLength(body) > 256 * 1024) throw new Error("oversized request");
      }
      const parsed = JSON.parse(body);
      requests.push({ method: request.method, path: request.url, body: parsed });
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const emit = (type, fields) =>
        response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
      emit("response.created", { response: { id: "response-fixture" } });
      emit("response.output_item.done", {
        item: {
          type: "message",
          role: "assistant",
          id: "message-fixture",
          content: [{ type: "output_text", text: "Synthetic completion." }],
        },
      });
      emit("response.completed", {
        response: {
          id: "response-fixture",
          usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
        },
      });
      response.end();
    } catch (error) {
      response.writeHead(400).end(JSON.stringify({ error: { message: String(error) } }));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const args = [
    "app-server",
    "--stdio",
    "--strict-config",
    "-c",
    'model_providers.zcode.name="ZCode fixture"',
    "-c",
    `model_providers.zcode.base_url="http://127.0.0.1:${port}/v1"`,
    "-c",
    'model_providers.zcode.env_key="ZCODE_CODEX_GATEWAY_TOKEN"',
    "-c",
    'model_providers.zcode.wire_api="responses"',
    ...spec.overrides.flatMap((entry) => ["-c", entry]),
  ];
  const fakeToken = `synthetic-${randomUUID()}`;
  const child = spawn("codex", args, {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: root,
      CODEX_HOME: home,
      LANG: "C.UTF-8",
      ZCODE_CODEX_GATEWAY_TOKEN: fakeToken,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let nextId = 0;
  const pending = new Map();
  let finish;
  const completion = new Promise((resolve, reject) => {
    finish = { resolve, reject };
  });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    if (Buffer.byteLength(buffer) > 1024 * 1024 && !buffer.includes("\n")) {
      finish.reject(new Error("oversized RPC frame"));
      child.kill();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > 1024 * 1024) {
        finish.reject(new Error("oversized RPC frame"));
        child.kill();
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        finish.reject(new Error("malformed RPC frame"));
        child.kill();
        return;
      }
      if (pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(`RPC failed: ${message.error.code}`));
        else entry.resolve(message.result);
      } else if (message.method === "turn/completed") finish.resolve(message.params?.turn?.status);
      else if (message.method && message.id !== undefined) {
        child.stdin.write(
          `${JSON.stringify({ id: message.id, error: { code: -32601, message: "synthetic probe denies all tools" } })}\n`,
        );
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString().replaceAll(fakeToken, "<redacted>")).slice(-1024);
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.once("error", (error) => finish.reject(error));
  child.once("exit", (code) => {
    for (const entry of pending.values())
      entry.reject(new Error(`Codex exited (${code}); ${stderr}`));
    pending.clear();
    finish.reject(new Error(`Codex exited (${code}); ${stderr}`));
  });
  const send = (method, params) => {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  };
  const deadline = setTimeout(() => {
    finish.reject(new Error("synthetic probe deadline exceeded"));
    child.kill();
  }, 12000);
  try {
    await send("initialize", {
      clientInfo: { name: "zcode-probe", title: "Synthetic probe", version: "0.1" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    const started = await send("thread/start", {
      model: "fixture-model",
      modelProvider: "zcode",
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
      ...spec.thread,
    });
    assert.equal(started.thread?.id && typeof started.thread.id, "string");
    await send("turn/start", {
      threadId: started.thread.id,
      input: [{ type: "text", text: "Synthetic one-word greeting." }],
      effort: "none",
      summary: "none",
    });
    assert.equal(await completion, "completed");
    assert.equal(requests.length, 1);
    // No auth headers or machine-specific cwd; all request fields and content remain present.
    const redacted = JSON.parse(
      JSON.stringify(requests[0])
        .replaceAll(root, "<isolated-cwd>")
        .replaceAll(fakeToken, "<redacted>"),
    );
    return {
      name: spec.name,
      configOverrides: spec.overrides,
      threadOverrides: spec.thread,
      request: redacted,
    };
  } finally {
    clearTimeout(deadline);
    if (child.exitCode === null) child.kill("SIGTERM");
    await exited;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
}

const results = [];
for (const spec of cases) results.push(await runCase(spec));
const fixture = {
  cliVersion: version,
  kind: "isolated synthetic fake Responses only",
  cases: results,
};
const output = join(
  dirname(fileURLToPath(import.meta.url)),
  "codexCompatibility0.156.1.fixture.json",
);
await writeFile(output, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(
  JSON.stringify({
    cliVersion: version,
    caseSummaries: results.map(({ name, request }) => ({
      name,
      toolTypes: request.body.tools.map((tool) => `${tool.type}:${tool.name ?? ""}`),
      inputRoles: request.body.input.map((item) => item.role),
      instructionsLength: request.body.instructions?.length ?? null,
      developerMessages: request.body.input
        .filter((item) => item.role === "developer")
        .map((item) => JSON.stringify(item).slice(0, 160)),
    })),
    fixture: output,
  }),
);
