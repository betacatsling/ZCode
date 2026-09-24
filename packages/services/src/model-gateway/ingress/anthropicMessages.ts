import type { ModelInputMessage, ModelMessageContentBlock, ModelRequest, ModelToolContract } from "@zcode/contracts";
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
  return value.map((block) => {
    const item = object(block);
    fields(item, ["type", "text"]);
    if (item.type !== "text") unsupported("unsupported_content_block");
    return text(item.text);
  }).join("");
}
function cacheMarker(value: unknown): ModelInputMessage["cacheControl"] {
  if (value === undefined) return undefined;
  const marker = object(value);
  fields(marker, ["type", "ttl", "scope"]);
  if (marker.type !== "ephemeral" || (marker.ttl !== undefined && marker.ttl !== "5m" && marker.ttl !== "1h") ||
    (marker.scope !== undefined && marker.scope !== "global" && marker.scope !== "org")) unsupported("unsupported_cache_control");
  return { type: "ephemeral", ...(marker.ttl ? { ttl: marker.ttl as "5m" | "1h" } : {}), ...(marker.scope ? { scope: marker.scope as "global" | "org" } : {}) };
}
function userContent(value: unknown): Pick<ModelInputMessage, "content" | "cacheControl"> {
  if (typeof value === "string") return { content: value };
  if (!Array.isArray(value)) invalid("invalid_content");
  const blocks: ModelMessageContentBlock[] = [];
  let cacheControl: ModelInputMessage["cacheControl"];
  for (const raw of value) {
    const part = object(raw);
    if (part.type === "text") {
      fields(part, ["type", "text", "cache_control"]);
      blocks.push({ type: "text", text: text(part.text) });
    } else if (part.type === "image") {
      fields(part, ["type", "source"]);
      const source = object(part.source);
      fields(source, ["type", "media_type", "data"]);
      if (source.type !== "base64" || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(source.media_type as string) ||
        typeof source.data !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(source.data) || !source.data)
        unsupported("unsupported_image");
      blocks.push({ type: "image", mediaType: source.media_type as string, dataUrl: `data:${source.media_type};base64,${source.data}` });
    } else unsupported("unsupported_content_block");
    if (part.cache_control !== undefined) {
      // 修复原因：Model 缓存标记属于整条消息，不能把多块内容的局部边界提升为整条消息缓存。
      if (value.length !== 1) unsupported("unsupported_cache_boundary");
      cacheControl = cacheMarker(part.cache_control);
    }
  }
  return { content: blocks.every((block) => block.type === "text") ? blocks.map((block) => (block as { text: string }).text).join("") : blocks, ...(cacheControl ? { cacheControl } : {}) };
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
  if (input.system !== undefined) {
    if (Array.isArray(input.system) && input.system.some((raw) => object(raw).cache_control !== undefined)) {
      for (const raw of input.system) {
        const block = object(raw);
        fields(block, ["type", "text", "cache_control"]);
        if (block.type !== "text") unsupported("unsupported_content_block");
        const cacheControl = cacheMarker(block.cache_control);
        messages.push({ role: "system", content: text(block.text), ...(cacheControl ? { cacheControl } : {}) });
      }
    } else messages.push({ role: "system", content: textBlocks(input.system) });
  }
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
          fields(part, ["type", "tool_use_id", "content", "is_error", "cache_control"]);
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
            ...(part.cache_control !== undefined ? { cacheControl: cacheMarker(part.cache_control) } : {}),
          });
        }
      } else {
        messages.push({ role: "user", ...userContent(content) });
      }
    } else {
      const toolCalls: NonNullable<ModelInputMessage["toolCalls"]> = [];
      const texts: string[] = [];
      const orderedContent: ModelMessageContentBlock[] = [];
      let hasReasoning = false;
      for (const block of content) {
        const part = object(block);
        if (part.type === "text") {
          fields(part, ["type", "text"]);
          if (toolCalls.length) unsupported("interleaved_assistant_content");
          const value = text(part.text);
          texts.push(value);
          orderedContent.push({ type: "text", text: value });
        } else if (part.type === "thinking") {
          fields(part, ["type", "thinking", "signature"]);
          if (toolCalls.length || typeof part.signature !== "string" || !part.signature) unsupported("unsupported_reasoning");
          hasReasoning = true;
          orderedContent.push({ type: "reasoning", text: text(part.thinking), providerOptions: { anthropic: { signature: part.signature } } });
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
        content: hasReasoning ? orderedContent : texts.join(""),
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
  allowedQueryParameters: { beta: ["true"] } as const,
  decode: decodeAnthropicMessagesRequest,
  encode: encodeAnthropicMessagesStream,
};
