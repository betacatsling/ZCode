// Synthetic Anthropic upstream for the SAME private V4 parent/child lifecycle as explicit live.
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function startPrivateFake({
  cwd,
  readPath,
  writePath,
  writeContent,
  bashCommand,
  changedContent,
  fault,
}) {
  const routeCounts = [0, 0, 0];
  let requests = 0;
  let forbiddenRequests = 0;
  let forbiddenRegisteredTools = 0;
  let baseUrl;
  const server = createServer(async (request, response) => {
    requests++;
    if (
      requests > 12 ||
      request.url !== "/fixture/v1/messages" ||
      request.method !== "POST" ||
      request.headers.host !== new URL(baseUrl).host
    )
      forbiddenRequests++;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    // 修复：检查真实送往 Model 的工具注册面，不只依赖响应流拦截成功。
    try {
      const serialized = JSON.parse(body.toString("utf8"));
      if (fault === "aux-interleave" && serialized.stream !== true) {
        // Synthetic scheduling fault only; Model invocation context, not stream flag, owns purpose.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (
        serialized.model !== "fixture-model" ||
        !Number.isSafeInteger(serialized.max_tokens) ||
        serialized.max_tokens < 1 ||
        serialized.max_tokens > 4096
      )
        forbiddenRequests++;
      const tools = serialized.tools ?? [];
      if (
        tools.some(
          (tool) =>
            ![
              "Read",
              "Write",
              "Bash",
              ...(fault === "webfetch-exposed" ? ["WebFetch"] : []),
            ].includes(tool.name),
        )
      )
        forbiddenRegisteredTools++;
    } catch {
      forbiddenRegisteredTools++;
      forbiddenRequests++;
    }
    const phase = body.includes(Buffer.from("fixture instruction 3"))
      ? 2
      : body.includes(Buffer.from("fixture instruction 2"))
        ? 1
        : 0;
    const step = routeCounts[phase]++;
    if (
      phase === 0 &&
      step === 0 &&
      ["echo-500", "endpoint-leak", "error-200", "broken-sse"].includes(fault)
    ) {
      if (fault === "echo-500") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: ["fixture-private", "key-sentinel"].join("-"), endpoint: baseUrl },
          }),
        );
      } else if (fault === "endpoint-leak") {
        // Synthetic only: prove that scanning the selected randomized endpoint rejects a persisted leak.
        await writeFile(join(cwd, "selected-endpoint-leak.txt"), baseUrl);
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: baseUrl } }));
      } else if (fault === "error-200") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: ["fixture-private", "key-sentinel"].join("-") } }),
        );
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "broken", content: ["fixture-private", "key-sentinel"].join("-") } })}\n\nevent: message_delta\ndata: BROKEN\n\n`,
        );
      }
      return;
    }
    const tool =
      phase === 0
        ? [
            { name: "Read", input: { file_path: readPath } },
            { name: "Write", input: { file_path: writePath, content: writeContent } },
          ][step]
        : phase === 1
          ? [
              { name: "Write", input: { file_path: writePath, content: writeContent } },
              { name: "Bash", input: { command: bashCommand } },
            ][step]
          : step === 0 && fault !== "no-read"
            ? { name: "Read", input: { file_path: fault === "wrong-read" ? writePath : readPath } }
            : undefined;
    if (phase === 0 && step === 0 && ["webfetch", "webfetch-exposed"].includes(fault))
      Object.assign(tool, {
        name: "WebFetch",
        input: { url: "https://react.dev/", prompt: "Read page" },
      });
    if (phase === 1 && step === 1 && fault === "wrong-bash")
      Object.assign(tool, { input: { command: "node other.cjs" } });
    if (phase === 1 && step === 0 && fault === "wrong-write")
      Object.assign(tool, { input: { file_path: writePath, content: "wrong" } });
    if (phase === 1 && step === 1 && fault === "extra-cwd")
      Object.assign(tool, { input: { command: bashCommand, cwd: cwd + "/other" } });
    if (phase === 0 && step === 0 && fault === "other-tool")
      Object.assign(tool, { name: "Glob", input: { pattern: "**/*", path: cwd } });
    if (
      phase === 0 &&
      step === 0 &&
      ["agent-compact", "task-multiline", "workflow-compact"].includes(fault)
    )
      Object.assign(tool, {
        name:
          fault === "agent-compact"
            ? "Agent"
            : fault === "task-multiline"
              ? "Task"
              : "CreateWorkflow",
        input: { prompt: "do not delegate" },
      });
    const sawFreshRead = phase === 2 && step > 0 && body.includes(Buffer.from(changedContent()));
    const event = (type, data) => {
      const json = JSON.stringify({ type, ...data });
      if (type === "content_block_start" && fault === "agent-compact")
        return `event: ${type}\ndata:${json}\n\n`;
      if (type === "content_block_start" && fault === "workflow-compact")
        return `event: ${type}\rdata:${json}\r\r`;
      if (type === "content_block_start" && fault === "task-multiline") {
        const split = json.indexOf(',"content_block"');
        return `event: ${type}\ndata:${json.slice(0, split + 1)}\ndata: ${json.slice(split + 1)}\n\n`;
      }
      return `event: ${type}\ndata: ${json}\n\n`;
    };
    response.writeHead(200, { "content-type": "text/event-stream" });
    const inputUsage =
      fault === "usage-zero"
        ? { input_tokens: 0, output_tokens: 0 }
        : fault === "usage-absent"
          ? undefined
          : { input_tokens: 4, output_tokens: 0 };
    const outputUsage =
      fault === "usage-zero"
        ? { output_tokens: 0 }
        : fault === "usage-absent"
          ? undefined
          : { output_tokens: 4 };
    response.end(
      event("message_start", {
        message: {
          id: `msg_fixture_${requests}`,
          type: "message",
          role: "assistant",
          model: "fixture-model",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          ...(inputUsage ? { usage: inputUsage } : {}),
        },
      }) +
        (tool
          ? event("content_block_start", {
              index: 0,
              content_block: {
                type: "tool_use",
                id: `toolu_fixture_${requests}`,
                name: tool.name,
                input: {},
              },
            }) +
            event("content_block_delta", {
              index: 0,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(tool.input) },
            })
          : event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
            event("content_block_delta", {
              index: 0,
              delta: {
                type: "text_delta",
                text:
                  sawFreshRead || (phase === 2 && fault === "no-read")
                    ? `Final read: ${changedContent()}`
                    : `fixture-turn-${phase + 1}`,
              },
            })) +
        event("content_block_stop", { index: 0 }) +
        event("message_delta", {
          delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
          ...(outputUsage ? { usage: outputUsage } : {}),
        }) +
        event("message_stop", {}),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}/fixture`;
  return {
    baseUrl,
    get counts() {
      return { requests, forbiddenRequests, forbiddenRegisteredTools, routeCounts };
    },
    close: async () => {
      server.closeAllConnections();
      let timer;
      try {
        await Promise.race([
          new Promise((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("fixture upstream cleanup timeout")), 1000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        server.closeAllConnections();
      }
    },
  };
}
