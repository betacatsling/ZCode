// Isolated fixed-CLI synthetic protocol probe. No upstream model or personal credentials.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.ZCODE_CLAUDE_PROBE !== "1") throw new Error("explicit probe opt-in required");
const root = await mkdtemp(join(tmpdir(), "zcode-claude-control-"));
const config = join(root, "profile");
await mkdir(config);
await writeFile(join(root, "denied-marker"), "original\n");
const key = `fixture-${randomUUID()}`;
let requests = 0;
const observations = [];
const server = createServer(async (req, res) => {
  if (req.method === "HEAD") { res.writeHead(200).end(); return; }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200000) { res.writeHead(413).end(); return; }
  }
  if (!req.url?.startsWith("/v1/messages")) { res.writeHead(404).end(); return; }
  const body = JSON.parse(raw);
  requests++;
  observations.push({ path: req.url, keys: Object.keys(body).sort(), tools: body.tools?.map((tool) => tool.name), roles: body.messages?.map((m) => m.role) });
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  const id = `msg_fixture_${requests}`;
  event("message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2, output_tokens: 0 } } });
  if (requests === 1) {
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fixture_001", name: "Edit", input: {} } });
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: join(root, "denied-marker"), old_string: "original", new_string: "modified" }) } });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
  } else {
    event("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } });
    event("content_block_stop", { type: "content_block_stop", index: 0 });
  }
  event("message_delta", { type: "message_delta", delta: { stop_reason: requests === 1 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } });
  event("message_stop", { type: "message_stop" });
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const child = spawn("claude", ["--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--model", "claude-sonnet-4-6", "--permission-prompts", "host", "--permission-mode", "default", "--strict-mcp-config", "--setting-sources", "", "--max-turns", "2"], {
  cwd: root,
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root, CLAUDE_CONFIG_DIR: config, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: key, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ENABLE_CLAUDEAI_MCP_SERVERS: "false", LANG: "C.UTF-8" },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
const frames = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  for (let index; (index = buffer.indexOf("\n")) >= 0;) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
    try {
      const msg = JSON.parse(line);
      frames.push({ type: msg.type, subtype: msg.subtype, request: msg.request, event: msg.event?.type, is_error: msg.is_error });
      if (msg.type === "control_request") {
        child.stdin.write(JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { behavior: "deny", message: "Fixture denied" } } }) + "\n");
      }
    } catch { /* diagnostic only */ }
  }
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-1000); });
child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: "Use Edit to change denied-marker from original to modified." } }) + "\n");
const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
try {
  const exit = await new Promise((resolve, reject) => { child.once("exit", (code, signal) => resolve({ code, signal })); child.once("error", reject); });
  console.log(JSON.stringify({ requests, observations, frames, marker: await readFile(join(root, "denied-marker"), "utf8"), exit, stderr: stderr.replaceAll(key, "<redacted>") }));
} finally {
  clearTimeout(timer);
  server.close();
  await rm(root, { recursive: true, force: true });
}
