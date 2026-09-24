// Explicit opt-in protocol probe: `ZCODE_CODEX_PROBE=1 node ...`.
// Uses fake token/model, isolated config/worktree, redacted structural output only.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

if (process.env.ZCODE_CODEX_PROBE !== "1") throw new Error("explicit probe opt-in required");
const root = await mkdtemp(join(tmpdir(), "zcode-codex-protocol-"));
await mkdir(join(root, "codex-home"));
const gateway = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) {
    raw += String(chunk);
    if (raw.length > 128000) { response.writeHead(413).end(); return; }
  }
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  console.log(JSON.stringify({
    ingress: { method: request.method, path: request.url,
      keys: body && typeof body === "object" ? Object.keys(body).sort() : [],
      inputKinds: Array.isArray(body?.input) ? body.input.map((item) => `${item?.type ?? typeof item}:${item?.role ?? ""}`) : [],
      toolNames: Array.isArray(body?.tools) ? body.tools.map((tool) => tool.name).slice(0, 32) : [],
      include: body?.include, reasoning: body?.reasoning,
      model: body?.model, stream: body?.stream, hasInstructions: Boolean(body?.instructions) },
  }));
  if (process.env.ZCODE_CODEX_PROBE_FAKE_SSE === "1" && request.url?.startsWith("/v1/responses") && body?.stream === true) {
    const id = `resp-${randomUUID()}`;
    const usage = { input_tokens: 10, input_tokens_details: null, output_tokens: 2, output_tokens_details: null, total_tokens: 12 };
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const emit = (type, fields) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
    emit("response.created", { response: { id } });
    emit("response.output_item.done", { item: { type: "message", role: "assistant", id: `msg-${randomUUID()}`, content: [{ type: "output_text", text: "Hello." }] } });
    emit("response.completed", { response: { id, usage } });
    response.end();
    return;
  }
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: { type: "unsupported_feature", message: "fixture intentionally stops before model execution" } }));
});
await new Promise((resolvePromise) => gateway.listen(0, "127.0.0.1", resolvePromise));
const port = gateway.address().port;
const args = ["app-server", "--stdio", "--strict-config",
  "-c", `model_providers.zcode.name="ZCode fixture"`,
  "-c", `model_providers.zcode.base_url="http://127.0.0.1:${port}/v1"`,
  "-c", 'model_providers.zcode.env_key="ZCODE_CODEX_GATEWAY_TOKEN"',
  "-c", 'model_providers.zcode.wire_api="responses"',
];
const fakeToken = `fixture-${randomUUID()}`;
const child = spawn("codex", args, {
  cwd: root,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, CODEX_HOME: join(root, "codex-home"),
    ZCODE_CODEX_GATEWAY_TOKEN: fakeToken, LANG: "C.UTF-8" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
const pending = new Map();
let nextId = 0;
let exited = false;
let stderr = "";
child.once("exit", (code) => {
  exited = true;
  if (code !== 0 && stderr) console.error(`codex-probe stderr: ${stderr.replaceAll(fakeToken, "<redacted>")}`);
  for (const pendingRequest of pending.values()) pendingRequest.reject(new Error(`codex app-server exited (${code})`));
  pending.clear();
});
let finished;
const completion = new Promise((resolvePromise) => { finished = resolvePromise; });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  for (;;) {
    const index = stdout.indexOf("\n");
    if (index < 0) break;
    const line = stdout.slice(0, index); stdout = stdout.slice(index + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id !== undefined && pending.has(message.id)) {
      const settled = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) settled.reject(new Error(JSON.stringify(message.error)));
      else settled.resolve(message.result);
    } else if (message.method) {
      console.log(JSON.stringify({ notification: message.method,
        paramKeys: Object.keys(message.params ?? {}).sort(),
        ...(message.params?.item ? { item: { type: message.params.item.type, idPresent: Boolean(message.params.item.id), keys: Object.keys(message.params.item).sort() } } : {}),
        ...(message.method === "turn/completed" ? { turn: { status: message.params.turn?.status, keys: Object.keys(message.params.turn ?? {}).sort() } } : {}),
        ...(message.method === "thread/tokenUsage/updated" ? { usageKeys: Object.keys(message.params.tokenUsage ?? {}).sort() } : {}),
      }));
      if (message.method === "turn/completed" || message.method === "error") finished();
      if (message.id !== undefined) {
        child.stdin.write(`${JSON.stringify({ id: message.id, error: { code: -32601, message: "probe cannot authorize tools" } })}\n`);
      }
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2048); }); // fake credentials and isolated profile only
const request = (method, params) => {
  const id = ++nextId;
  return new Promise((resolvePromise, rejectPromise) => {
    pending.set(id, { resolve: resolvePromise, reject: rejectPromise });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
};
const deadline = setTimeout(() => {
  for (const pendingRequest of pending.values()) pendingRequest.reject(new Error("codex app-server probe timed out"));
  pending.clear();
  finished();
}, 18000);
try {
  await request("initialize", { clientInfo: { name: "zcode-probe", title: "ZCode probe", version: "0.1" }, capabilities: { experimentalApi: false, requestAttestation: false } });
  console.log(JSON.stringify({ initialized: true }));
  child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  const started = await request("thread/start", { model: "fixture-model", modelProvider: "zcode", cwd: root,
    approvalPolicy: "never", sandbox: "read-only", baseInstructions: "Respond with exactly one word." });
  const threadId = started?.thread?.id ?? started?.threadId;
  if (!threadId) throw new Error(`thread/start missing ID: ${JSON.stringify(started)}`);
  console.log(JSON.stringify({ threadStarted: true }));
  await request("turn/start", { threadId, input: [{ type: "text", text: "Say hi." }],
    ...(process.env.ZCODE_CODEX_PROBE_NO_REASONING === "1" ? { effort: "none", summary: "none" } : {}),
  });
  await completion;
} finally {
  clearTimeout(deadline);
  if (!exited) {
    child.kill("SIGTERM");
    await new Promise((resolvePromise) => child.once("exit", resolvePromise));
  }
  gateway.close();
  await rm(root, { recursive: true, force: true });
}
