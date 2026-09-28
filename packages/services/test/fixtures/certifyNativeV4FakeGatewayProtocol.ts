import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export type FakeGatewayJsonRecord = Record<string, unknown>;

export function objectRecord(value: unknown): FakeGatewayJsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as FakeGatewayJsonRecord)
    : undefined;
}

function sseLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

export function emitTextResponse(response: ServerResponse, text: string): void {
  response.write(
    sseLine({ choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }] }),
  );
  response.write(
    sseLine({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 },
    }),
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

export function emitToolResponse(
  response: ServerResponse,
  toolName: "Read" | "Write" | "Bash",
  input: FakeGatewayJsonRecord,
): void {
  response.write(
    sseLine({
      choices: [
        {
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${randomUUID()}`,
                type: "function",
                function: { name: toolName, arguments: JSON.stringify(input) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
  );
  response.write(
    sseLine({
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 18, completion_tokens: 9, total_tokens: 27 },
    }),
  );
  response.write("data: [DONE]\n\n");
  response.end();
}

export function messageText(message: FakeGatewayJsonRecord): string {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const part = objectRecord(item);
      return typeof part?.text === "string" ? part.text : "";
    })
    .join("\n");
}

export function messagesFrom(body: FakeGatewayJsonRecord): FakeGatewayJsonRecord[] {
  if (!Array.isArray(body.messages)) throw new Error("fake Provider request is missing messages");
  return body.messages.map((message) => {
    const parsed = objectRecord(message);
    if (!parsed || typeof parsed.role !== "string")
      throw new Error("fake Provider request contains an invalid message");
    return parsed;
  });
}

export function normalizePrompt(value: string): string {
  return value.trim().replaceAll(/\s+/gu, " ");
}

export async function readJsonRequest(request: IncomingMessage): Promise<FakeGatewayJsonRecord> {
  return new Promise((resolvePromise, rejectPromise) => {
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 512_000) rejectPromise(new Error("native fake Provider request too large"));
    });
    request.once("error", rejectPromise);
    request.once("end", () => {
      try {
        const parsed = objectRecord(JSON.parse(raw));
        if (!parsed) throw new Error("native fake Provider request must be an object");
        resolvePromise(parsed);
      } catch (error) {
        rejectPromise(error);
      }
    });
  });
}
