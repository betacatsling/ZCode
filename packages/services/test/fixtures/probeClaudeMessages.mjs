// Explicit opt-in diagnostic: `ZCODE_CLAUDE_PROBE=1 node ...`.
// No real Provider: fake key, synthetic prompt, temporary HOME/workspace/profile.
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

if (process.env.ZCODE_CLAUDE_PROBE !== "1") throw new Error("explicit probe opt-in required");
const root = await mkdtemp(join(tmpdir(), "zcode-claude-protocol-"));
await mkdir(join(root, "claude-config"));
const fakeKey = `fixture-${randomUUID()}`;
const gateway = createServer(async (request, response) => {
  let raw = "";
  for await (const chunk of request) {
    raw += String(chunk);
    if (raw.length > 128000) { response.writeHead(413).end(); return; }
  }
  let body;
  try { body = JSON.parse(raw); } catch { body = null; }
  console.log(JSON.stringify({ ingress: {
    method: request.method, path: request.url,
    keys: body && typeof body === "object" ? Object.keys(body).sort() : [],
    model: body?.model, stream: body?.stream,
    systemKinds: Array.isArray(body?.system) ? body.system.map((item) => item?.type) : typeof body?.system,
    messageRoles: Array.isArray(body?.messages) ? body.messages.map((message) => message?.role).slice(0, 16) : [],
    toolNames: Array.isArray(body?.tools) ? body.tools.map((tool) => tool?.name).slice(0, 32) : [],
    anthropicHeaders: Object.keys(request.headers).filter((key) => key.startsWith("anthropic-")).sort(),
  } }));
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "fixture stops before model execution" } }));
});
await new Promise((resolvePromise) => gateway.listen(0, "127.0.0.1", resolvePromise));
const port = gateway.address().port;
const child = spawn("claude", ["-p", "Say hi.", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  "--model", "claude-sonnet-4-6", "--permission-prompts", "none", "--permission-mode", "default", "--strict-mcp-config",
  "--setting-sources", "", "--bare", "--max-turns", "1"], {
  cwd: root,
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, CLAUDE_CONFIG_DIR: join(root, "claude-config"),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: fakeKey,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    LANG: "C.UTF-8",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  for (;;) {
    const index = stdout.indexOf("\n");
    if (index < 0) break;
    const line = stdout.slice(0, index); stdout = stdout.slice(index + 1);
    try {
      const message = JSON.parse(line);
      console.log(JSON.stringify({ event: message.type, subtype: message.subtype,
        ...(message.type === "stream_event" ? { streamType: message.event?.type } : {}),
      }));
    } catch { /* Only parse structured messages. */ }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1600); });
const timeout = setTimeout(() => child.kill("SIGTERM"), 25000);
try {
  const code = await new Promise((resolvePromise, rejectPromise) => {
    child.once("exit", resolvePromise);
    child.once("error", rejectPromise);
  });
  if (stderr) console.error(`claude-probe stderr: ${stderr.replaceAll(fakeKey, "<redacted>")}`);
  console.log(JSON.stringify({ exitCode: code }));
} finally {
  clearTimeout(timeout);
  gateway.close();
  await rm(root, { recursive: true, force: true });
}
