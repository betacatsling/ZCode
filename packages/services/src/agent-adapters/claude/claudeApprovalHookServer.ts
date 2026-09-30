import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface ClaudePreToolUseInput {
  readonly hook_event_name: string;
  readonly session_id: string;
  readonly tool_name: string;
  readonly tool_use_id: string;
  readonly tool_input: unknown;
}

export type ClaudeHookDecision = "allow" | "deny";

export class ClaudeApprovalHookServer {
  readonly #secret = randomBytes(32).toString("base64url");
  readonly #server: Server;
  #baseUrl?: string;
  #closed = false;

  constructor(
    private readonly handleRequest: (
      input: ClaudePreToolUseInput,
      signal: AbortSignal,
    ) => Promise<ClaudeHookDecision>,
  ) {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  async start(): Promise<string> {
    if (this.#closed) throw new Error("Claude approval hook server is closed");
    if (this.#baseUrl) return this.#baseUrl;
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.off("error", reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (!address || typeof address === "string")
      throw new Error("Claude hook did not bind loopback");
    this.#baseUrl = `http://127.0.0.1:${address.port}/${this.#secret}`;
    return this.#baseUrl;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (!this.#baseUrl) return;
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolve())),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#closed || request.method !== "POST" || request.url !== `/${this.#secret}`) {
      writeJson(response, 404, denyBody("Hook route is unavailable"));
      return;
    }
    if (request.headers["content-type"]?.split(";", 1)[0]?.trim() !== "application/json") {
      writeJson(response, 400, denyBody("Hook request must be JSON"));
      return;
    }
    try {
      const body = await readLimitedJson(request, 512 * 1024);
      if (
        body.hook_event_name !== "PreToolUse" ||
        !nonEmptyString(body.session_id) ||
        !nonEmptyString(body.tool_name) ||
        !nonEmptyString(body.tool_use_id) ||
        body.tool_input === undefined
      ) {
        writeJson(response, 400, denyBody("PreToolUse callback is invalid"));
        return;
      }
      const requestAbort = new AbortController();
      const onClose = () => {
        if (!response.writableEnded) requestAbort.abort();
      };
      response.once("close", onClose);
      const decision = await this.handleRequest(
        body as unknown as ClaudePreToolUseInput,
        requestAbort.signal,
      );
      response.off("close", onClose);
      writeJson(response, 200, {
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: decision,
          permissionDecisionReason:
            decision === "allow"
              ? "Allowed by the active Host turn"
              : "Denied by the active Host turn",
        },
      });
    } catch {
      if (!response.headersSent) writeJson(response, 200, denyBody("Host approval is unavailable"));
      else response.end();
    }
  }
}

async function readLimitedJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.byteLength;
    if (length > maxBytes) throw new Error("hook request exceeds limit");
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, length).toString("utf8"));
  } catch {
    throw new Error("hook request JSON is invalid");
  }
  if (!isRecord(value)) throw new Error("hook request must be an object");
  return value;
}

function writeJson(response: ServerResponse, status: number, body: Record<string, unknown>): void {
  if (response.destroyed) return;
  const serialized = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(serialized),
    "cache-control": "no-store",
    connection: "close",
  });
  response.end(serialized);
}

function denyBody(reason: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
