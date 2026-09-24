import type { ModelInputMessage, ModelRequest, ModelToolContract } from "@zcode/contracts";
import { encodeAnthropicMessagesStream } from "../egress/anthropicMessages.js";

export class AnthropicMessagesCodecError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: 400 | 422,
  ) {
    super(`Anthropic Messages codec: ${code}`);
    this.name = "AnthropicMessagesCodecError";
  }
}

function invalid(code: string): never {
  throw new AnthropicMessagesCodecError(code, 400);
}
function unsupported(code: string): never {
  throw new AnthropicMessagesCodecError(code, 422);
}
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    invalid("invalid_object");
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) unsupported("unsupported_field");
}
function name(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) invalid("invalid_identifier");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string") invalid("invalid_text");
  return value;
}
function textBlocks(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) invalid("invalid_content");
  return value
    .map((block) => {
      const item = object(block);
      fields(item, ["type", "text"]);
      if (item.type !== "text") unsupported("unsupported_content_block");
      return text(item.text);
    })
    .join("");
}

/** Validate before invoking the model: no unrepresentable wire fields may be dropped. */
export function decodeAnthropicMessagesRequest(
  body: unknown,
  headers: Readonly<Record<string, string | undefined>>,
): { request: ModelRequest; modelId: string; stream: true } {
  const version = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === "anthropic-version",
  )?.[1];
  if (version !== "2023-06-01") unsupported("unsupported_version");
  if (Object.keys(headers).some((key) => key.toLowerCase() === "anthropic-beta"))
    unsupported("unsupported_beta");
  if (
    Object.keys(headers).some(
      (key) =>
        key.toLowerCase().startsWith("anthropic-") && key.toLowerCase() !== "anthropic-version",
    )
  )
    unsupported("unsupported_header");
  const input = object(body);
  fields(input, ["model", "max_tokens", "stream", "system", "messages", "tools"]);
  const modelId = name(input.model);
  if (input.stream !== true) unsupported("stream_required");
  if (!Number.isSafeInteger(input.max_tokens) || (input.max_tokens as number) < 1)
    invalid("invalid_max_tokens");
  if (!Array.isArray(input.messages) || input.messages.length === 0) invalid("invalid_messages");
  const messages: ModelInputMessage[] = [];
  if (input.system !== undefined)
    messages.push({ role: "system", content: textBlocks(input.system) });
  const calls = new Map<string, string>();
  const resolved = new Set<string>();
  for (const raw of input.messages) {
    const message = object(raw);
    fields(message, ["role", "content"]);
    if (message.role !== "user" && message.role !== "assistant") invalid("invalid_role");
    const content = message.content;
    if (typeof content === "string") {
      messages.push({ role: message.role, content });
      continue;
    }
    if (!Array.isArray(content)) invalid("invalid_content");
    if (message.role === "user") {
      const parts = content.map(object);
      const results = parts.filter((part) => part.type === "tool_result");
      if (results.length) {
        if (results.length !== parts.length) unsupported("mixed_tool_results");
        for (const part of results) {
          fields(part, ["type", "tool_use_id", "content", "is_error"]);
          const id = name(part.tool_use_id);
          const toolName = calls.get(id);
          if (!toolName || resolved.has(id)) invalid("unmatched_tool_result");
          if (part.is_error !== undefined && typeof part.is_error !== "boolean")
            invalid("invalid_tool_result");
          resolved.add(id);
          messages.push({
            role: "tool",
            content: textBlocks(part.content),
            toolCallId: id,
            toolName,
            isError: part.is_error === true,
          });
        }
      } else {
        messages.push({ role: "user", content: textBlocks(content) });
      }
    } else {
      const toolCalls: NonNullable<ModelInputMessage["toolCalls"]> = [];
      const texts: string[] = [];
      for (const block of content) {
        const part = object(block);
        if (part.type === "text") {
          fields(part, ["type", "text"]);
          if (toolCalls.length) unsupported("interleaved_assistant_content");
          texts.push(text(part.text));
        } else if (part.type === "tool_use") {
          fields(part, ["type", "id", "name", "input"]);
          const id = name(part.id);
          const toolName = name(part.name);
          if (calls.has(id)) invalid("duplicate_tool_id");
          const toolInput = object(part.input);
          calls.set(id, toolName);
          toolCalls.push({ id, name: toolName, input: toolInput });
        } else unsupported("unsupported_content_block");
      }
      messages.push({
        role: "assistant",
        content: texts.join(""),
        ...(toolCalls.length ? { toolCalls } : {}),
      });
    }
  }
  if (input.tools !== undefined && !Array.isArray(input.tools)) invalid("invalid_tools");
  const tools: ModelToolContract[] | undefined = (input.tools as unknown[] | undefined)?.map(
    (raw) => {
      const tool = object(raw);
      fields(tool, ["name", "description", "input_schema"]);
      const toolName = name(tool.name);
      if (tool.description !== undefined) text(tool.description);
      const inputSchema = object(tool.input_schema);
      return {
        name: toolName,
        ...(tool.description === undefined ? {} : { description: tool.description as string }),
        inputSchema,
      };
    },
  );
  if (tools && new Set(tools.map((tool) => tool.name)).size !== tools.length)
    invalid("duplicate_tool_name");
  return {
    request: {
      messages,
      ...(tools === undefined ? {} : { tools }),
      options: { maxOutputTokens: input.max_tokens as number },
    },
    modelId,
    stream: true,
  };
}

export const anthropicMessagesProtocol = {
  id: "anthropic-messages" as const,
  paths: ["/v1/messages"] as const,
  decode: decodeAnthropicMessagesRequest,
  encode: encodeAnthropicMessagesStream,
};
