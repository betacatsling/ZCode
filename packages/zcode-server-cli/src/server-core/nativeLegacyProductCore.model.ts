import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { join } from "node:path";

/** Provider stub 发出 Write tool_call 的目标文件与内容，是模型 stub 与断言共享的契约。 */
export const WRITE_FILE_NAME = "legacy-approved-write.txt";
export const WRITE_CONTENT = "approved legacy write\n";

interface HeldGateInternal {
  /** Resolves once the held request has actually reached the provider stub. */
  arrived: Promise<void>;
  /** Resolves when the fixture lets the held response finish. */
  released: Promise<void>;
  notifyArrived(): void;
  releaseResponse(): void;
}

export interface HeldGate {
  /** Resolves once the held request has actually reached the provider stub. */
  arrived: Promise<void>;
  /** Let the parked upstream response finish (or observe that stop aborted it). */
  release(): void;
}

export interface FixtureModel {
  url: string;
  /** Models actually requested, in request order. */
  calls: string[];
  /** Raw provider request bodies, in request order. */
  requests: string[];
  /** Held-turn admission proof: the third request parks upstream until released. */
  heldQueue: HeldGate;
  /** Stop proof: the twelfth request parks upstream until released or aborted. */
  heldStop: HeldGate;
  close(): Promise<void>;
}

function heldGate(): HeldGateInternal {
  let notifyArrived: () => void = () => {};
  let releaseResponse: () => void = () => {};
  const arrived = new Promise<void>((resolve) => {
    notifyArrived = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  return { arrived, released, notifyArrived, releaseResponse };
}

function toGate(internal: HeldGateInternal): HeldGate {
  return { arrived: internal.arrived, release: () => internal.releaseResponse() };
}

/**
 * Loopback SSE model stub. Call index is the behaviour switch:
 * call 3 is the held parent turn, calls 8/10 emit Write tool calls,
 * call 12 is the in-flight request that stop must abort.
 */
export async function startFixtureModel(cwd: string): Promise<FixtureModel> {
  const calls: string[] = [];
  const requests: string[] = [];
  const heldQueue = heldGate();
  const heldStop = heldGate();
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let model = "unknown";
    try {
      const body = Buffer.concat(chunks).toString();
      requests.push(body);
      model = String((JSON.parse(body) as { model?: unknown }).model);
    } catch {
      response.writeHead(400).end();
      return;
    }
    calls.push(model);
    const event = (type: string, data: object) =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (calls.length === 3) {
      heldQueue.notifyArrived();
      await heldQueue.released;
    }
    if (calls.length === 12) {
      heldStop.notifyArrived();
      await heldStop.released;
    }
    // stop 会 abort 在飞请求；连接已毁时不再写响应体。
    if (response.destroyed || response.writableEnded) return;
    const writeTool = calls.length === 8 || calls.length === 10;
    response.end(
      event("message_start", {
        message: {
          id: `legacy-core-${calls.length}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      }) +
        (writeTool
          ? event("content_block_start", {
              index: 0,
              content_block: {
                type: "tool_use",
                id: `legacy-write-${calls.length}`,
                name: "Write",
                input: {},
              },
            }) +
            event("content_block_delta", {
              index: 0,
              delta: {
                type: "input_json_delta",
                partial_json: JSON.stringify({
                  file_path: join(cwd, WRITE_FILE_NAME),
                  content: WRITE_CONTENT,
                }),
              },
            })
          : event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
            event("content_block_delta", {
              index: 0,
              delta: { type: "text_delta", text: "native legacy core fixture response" },
            })) +
        event("content_block_stop", { index: 0 }) +
        event("message_delta", {
          delta: { stop_reason: writeTool ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { output_tokens: 4 },
        }) +
        event("message_stop", {}),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    url: `http://127.0.0.1:${address.port}/fixture`,
    calls,
    requests,
    heldQueue: toGate(heldQueue),
    heldStop: toGate(heldStop),
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
