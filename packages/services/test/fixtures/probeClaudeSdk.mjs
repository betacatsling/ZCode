// Isolated fixed-CLI synthetic protocol probe. No upstream model or personal credentials.
import { ClaudeCodeTransport } from "../../src/agent-adapters/claude-code/claudeTransport.ts";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.ZCODE_CLAUDE_PROBE !== "1") throw new Error("explicit probe opt-in required");
const root = await mkdtemp(join(tmpdir(), "zcode-claude-control-"));
const config = join(root, "profile");
const workspace = join(root, "workspace");
await mkdir(config);
await mkdir(workspace);
await writeFile(join(workspace, "denied-marker"), "original\n");
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
    event("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ file_path: join(workspace, "denied-marker"), old_string: "original", new_string: "modified" }) } });
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

const events = [];
const transport = new ClaudeCodeTransport({ cwd: workspace, profileDir: config, gatewayUrl: `http://127.0.0.1:${server.address().port}`, gatewayToken: key, model: "claude-sonnet-4-6" });
try {
 const result = await transport.run("Use Edit to change denied-marker from original to modified.", (event) => {
  events.push(event.type === "session" ? { type: event.type, version: event.version } : event.type === "permission" ? { type: event.type, id: event.id, name: event.name } : { type: event.type });
  if (event.type === "permission") {
    setTimeout(async () => {
      const unchangedBeforeDenial = (await readFile(join(workspace, "denied-marker"), "utf8")) === "original\n";
      events.push({ type: "preExecutionCheck", unchangedBeforeDenial });
      if (process.env.ZCODE_CLAUDE_PROBE_CANCEL === "1") {
        transport.cancel();
        events.push({ type: "lateReply", accepted: transport.reply(event.id, "allow") });
      } else events.push({ type: "reply", accepted: transport.reply(event.id, process.env.ZCODE_CLAUDE_PROBE_ALLOW === "1" ? "allow" : "deny") });
    }, 100);
  }
 });
 console.log(JSON.stringify({ requests, observations, events, sessionRecorded: Boolean(result.nativeSessionId), marker: await readFile(join(workspace, "denied-marker"), "utf8") }));
} catch (error) {
 console.log(JSON.stringify({ requests, observations, events, error: String(error).replaceAll(key, "<redacted>").slice(0,200), marker: await readFile(join(workspace, "denied-marker"), "utf8") }));
} finally {
 server.close(); await rm(root, { recursive: true, force: true });
}
