import { ClaudeCodeTransport } from "../../src/agent-adapters/claude-code/claudeTransport.ts";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
if (process.env.ZCODE_CLAUDE_PROBE !== "1") throw new Error("explicit local probe opt-in required");
const root = await mkdtemp(join(tmpdir(), "zcode-claude-resume-"));
const cwd = join(root, "workspace"),
  profileDir = join(root, "profile");
await mkdir(cwd);
await mkdir(profileDir);
let requests = 0;
const key = `fixture-${randomUUID()}`;
const server = createServer(async (req, res) => {
  if (req.method === "HEAD") {
    res.writeHead(200).end();
    return;
  }
  if (!req.url?.startsWith("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 200000) {
      res.writeHead(413).end();
      return;
    }
  }
  requests++;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  event("message_start", {
    type: "message_start",
    message: {
      id: `msg_fixture_${requests}`,
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 0 },
    },
  });
  event("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  event("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "ok" },
  });
  event("content_block_stop", { type: "content_block_stop", index: 0 });
  event("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  });
  event("message_stop", { type: "message_stop" });
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const id = randomUUID();
const base = {
  cwd,
  profileDir,
  gatewayUrl: `http://127.0.0.1:${server.address().port}`,
  gatewayToken: key,
  model: "claude-sonnet-4-6",
};
try {
  const first = await new ClaudeCodeTransport({ ...base, sessionId: id }).run("Reply ok", () => {});
  const second = await new ClaudeCodeTransport({ ...base, resumeId: id }).run(
    "Reply ok again",
    () => {},
  );
  console.log(
    JSON.stringify({
      firstMatches: first.nativeSessionId === id,
      secondMatches: second.nativeSessionId === id,
      requests,
    }),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      firstMatches: false,
      secondMatches: false,
      requests,
      error: String(error).replaceAll(key, "<redacted>").slice(0, 200),
    }),
  );
  process.exitCode = 1;
} finally {
  server.close();
  await rm(root, { recursive: true, force: true });
}
