// Disposable pinned native-client wire probe. Never contacts a Provider or reads personal Claude config.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mode = process.env.ZCODE_CLAUDE_HEADER_PROBE;
if (mode !== "baseline" && mode !== "marker" && mode !== "empty")
  throw new Error("explicit_header_probe_mode_required");
const sdkPackage = JSON.parse(
  await readFile(
    new URL("./package.json", import.meta.resolve("@anthropic-ai/claude-agent-sdk")),
    "utf8",
  ),
);
const root = await mkdtemp(join(tmpdir(), "zcode-claude-header-"));
const workspace = join(root, "workspace");
const profile = join(root, "profile");
await mkdir(workspace);
await mkdir(profile);
let requests = 0;
let observation;
const server = createServer(async (req, res) => {
  if (req.method === "HEAD") {
    res.writeHead(200).end();
    return;
  }
  if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
    res.writeHead(404).end();
    return;
  }
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 200000) {
      res.writeHead(413).end();
      return;
    }
  }
  const body = JSON.parse(raw);
  requests++;
  observation = {
    beta: String(req.headers["anthropic-beta"] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .sort(),
    betaHeaderPresent: Object.hasOwn(req.headers, "anthropic-beta"),
    path: req.url,
    thinkingType: body.thinking?.type,
    hasContextManagement: "context_management" in body,
    hasDeferredToolShape: (body.tools ?? []).some(
      (tool) => "defer_loading" in tool || "eager_input_streaming" in tool,
    ),
    probeHeader: req.headers["x-zcode-fixture-probe"],
  };
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const emit = (name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("message_start", {
    type: "message_start",
    message: {
      id: "msg_fixture_header",
      type: "message",
      role: "assistant",
      model: body.model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 2, output_tokens: 0 },
    },
  });
  emit("content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  });
  emit("content_block_delta", {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "done" },
  });
  emit("content_block_stop", { type: "content_block_stop", index: 0 });
  emit("message_delta", {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 2 },
  });
  emit("message_stop", { type: "message_stop" });
  res.end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
let error;
let stream;
let nativeVersion;
let nativeSuccess = false;
try {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: profile,
    CLAUDE_CONFIG_DIR: profile,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`,
    ANTHROPIC_API_KEY: "fixture-only-header-key",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    LANG: "C.UTF-8",
    ...(mode === "empty"
      ? { ANTHROPIC_CUSTOM_HEADERS: "anthropic-beta: " }
      : mode === "marker"
        ? { ANTHROPIC_CUSTOM_HEADERS: "x-zcode-fixture-probe: on" }
        : {}),
  };
  stream = query({
    prompt: "Reply done.",
    options: {
      cwd: workspace,
      model: "claude-sonnet-4-6",
      thinking: { type: "disabled" },
      settingSources: [],
      strictMcpConfig: true,
      tools: ["Read", "Edit", "Write", "Bash"],
      permissionMode: "default",
      permissionPrompts: "host",
      includePartialMessages: true,
      env,
      canUseTool: async () => ({ behavior: "deny", message: "fixture denies tools" }),
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async () => ({
                hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
              }),
            ],
          },
        ],
      },
    },
  });
  for await (const message of stream) {
    if (message.type === "system" && message.subtype === "init")
      nativeVersion = message.claude_code_version;
    if (message.type === "result") {
      nativeSuccess = message.subtype === "success" && !message.is_error;
      if (!nativeSuccess) error = "native_result_error";
    }
  }
} catch {
  error = "native_probe_failed";
} finally {
  stream?.close();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    sdkVersion: sdkPackage.version,
    bundledVersion: sdkPackage.claudeCodeVersion,
    nativeVersion,
    nativeSuccess,
    requests,
    ...observation,
    error,
  }),
);
