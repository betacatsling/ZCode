import type {
  JsonSchema,
  Model,
  ModelInputMessage,
  ModelToolContract,
  ModelUsage,
} from "@zcode/contracts";
import { invalidRequest, unsupportedFeature } from "./errors.js";

export interface DecodedMessagesRequest {
  readonly messages: ModelInputMessage[];
  readonly systemInstructions?: string;
  readonly tools: ModelToolContract[];
  readonly model: string;
  readonly maxOutputTokens: number;
  readonly effort: "low" | "medium" | "high" | "xhigh" | "max";
}

export const pinnedAnthropicBetas = new Set([
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "thinking-token-count-2026-05-13",
  "context-management-2025-06-27",
  "prompt-caching-scope-2026-01-05",
  "mid-conversation-system-2026-04-07",
  "effort-2025-11-24",
]);

type JsonObject = Record<string, unknown>;
type ToolCall = NonNullable<ModelInputMessage["toolCalls"]>[number];

function object(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    invalidRequest(`${path} must be an object`);
  return value as JsonObject;
}

function exactKeys(
  value: JsonObject,
  allowed: readonly string[],
  path: string,
  required: readonly string[] = [],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) unsupportedFeature(`${path}.${key} is not supported`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalidRequest(`${path}.${key} is required`);
  }
}

function boundedString(value: unknown, path: string, maxLength = 1_000_000): string {
  if (typeof value !== "string" || value.length > maxLength)
    invalidRequest(`${path} must be a bounded string`);
  return value;
}

function assertTextBlock(value: unknown, path: string): string {
  const block = object(value, path);
  exactKeys(block, ["text", "type"], path, ["text", "type"]);
  if (block.type !== "text") unsupportedFeature(`${path}.type is not supported`);
  return boundedString(block.text, `${path}.text`);
}

function textContent(value: unknown, path: string): string | { type: "text"; text: string }[] {
  if (typeof value === "string") return boundedString(value, path);
  if (!Array.isArray(value) || value.length > 2_048)
    unsupportedFeature(`${path} must contain text only`);
  return value.map((block, index) => ({
    type: "text" as const,
    text: assertTextBlock(block, `${path}[${index}]`),
  }));
}

function parseSystem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return boundedString(value, "system");
  if (!Array.isArray(value) || value.length > 2_048)
    unsupportedFeature("system must contain text blocks only");
  return value.map((block, index) => assertTextBlock(block, `system[${index}]`)).join("\n\n");
}

function parseTools(value: unknown): ModelToolContract[] {
  if (!Array.isArray(value) || value.length > 256) invalidRequest("tools must be a bounded array");
  const names = new Set<string>();
  return value.map((entry, index) => {
    const path = `tools[${index}]`;
    const tool = object(entry, path);
    exactKeys(tool, ["description", "input_schema", "name"], path, [
      "description",
      "input_schema",
      "name",
    ]);
    const name = boundedString(tool.name, `${path}.name`, 128);
    const description = boundedString(tool.description, `${path}.description`, 16_000);
    if (!name || names.has(name)) invalidRequest(`${path}.name must be non-empty and unique`);
    names.add(name);
    const inputSchema = object(tool.input_schema, `${path}.input_schema`) as JsonSchema;
    return { name, description, inputSchema };
  });
}

function parseMetadata(value: unknown): void {
  if (value === undefined) return;
  const metadata = object(value, "metadata");
  exactKeys(metadata, ["user_id"], "metadata");
  if (metadata.user_id !== undefined) boundedString(metadata.user_id, "metadata.user_id", 128);
}

function appendUserOrToolMessages(
  output: ModelInputMessage[],
  message: JsonObject,
  path: string,
  calls: Map<string, { readonly name: string; resultSeen: boolean }>,
): void {
  const role = boundedString(message.role, `${path}.role`, 32);
  if (role === "developer")
    unsupportedFeature(`${path}.role developer cannot be represented by Anthropic Messages`);
  if (role !== "user" && role !== "assistant" && role !== "system")
    unsupportedFeature(`${path}.role is not supported`);
  if (typeof message.content === "string") {
    exactKeys(message, ["content", "role"], path, ["content", "role"]);
    output.push({ role, content: boundedString(message.content, `${path}.content`) });
    return;
  }
  if (!Array.isArray(message.content) || message.content.length > 2_048)
    unsupportedFeature(`${path}.content must contain supported blocks`);

  const blocks = message.content as unknown[];
  if (role === "system") {
    output.push({ role, content: textContent(blocks, `${path}.content`) });
    return;
  }
  if (role === "assistant") {
    let text = "";
    const toolCalls: ToolCall[] = [];
    let sawTool = false;
    for (const [index, entry] of blocks.entries()) {
      const blockPath = `${path}.content[${index}]`;
      const block = object(entry, blockPath);
      if (block.type === "text") {
        exactKeys(block, ["text", "type"], blockPath, ["text", "type"]);
        if (sawTool) unsupportedFeature("assistant text after tool_use is not representable");
        text += boundedString(block.text, `${blockPath}.text`);
        continue;
      }
      if (block.type !== "tool_use") unsupportedFeature(`${blockPath}.type is not supported`);
      exactKeys(block, ["id", "input", "name", "type"], blockPath, [
        "id",
        "input",
        "name",
        "type",
      ]);
      const id = boundedString(block.id, `${blockPath}.id`, 256);
      const name = boundedString(block.name, `${blockPath}.name`, 128);
      if (!id || !name || calls.has(id)) invalidRequest(`${blockPath} has an invalid or duplicate tool_use id`);
      const input = object(block.input, `${blockPath}.input`);
      calls.set(id, { name, resultSeen: false });
      toolCalls.push({ id, name, input });
      sawTool = true;
    }
    output.push({ role, content: text, ...(toolCalls.length ? { toolCalls } : {}) });
    return;
  }

  let textBlocks: { type: "text"; text: string }[] = [];
  const flushUserText = () => {
    if (!textBlocks.length) return;
    output.push({ role: "user", content: textBlocks });
    textBlocks = [];
  };
  for (const [index, entry] of blocks.entries()) {
    const blockPath = `${path}.content[${index}]`;
    const block = object(entry, blockPath);
    if (block.type === "text") {
      exactKeys(block, ["text", "type"], blockPath, ["text", "type"]);
      textBlocks.push({ type: "text", text: boundedString(block.text, `${blockPath}.text`) });
      continue;
    }
    if (block.type !== "tool_result") unsupportedFeature(`${blockPath}.type is not supported`);
    exactKeys(block, ["content", "is_error", "tool_use_id", "type"], blockPath, [
      "content",
      "tool_use_id",
      "type",
    ]);
    const id = boundedString(block.tool_use_id, `${blockPath}.tool_use_id`, 256);
    const call = calls.get(id);
    if (!call || call.resultSeen) invalidRequest(`${blockPath}.tool_use_id has no unmatched tool_use`);
    if (block.is_error !== undefined && typeof block.is_error !== "boolean")
      invalidRequest(`${blockPath}.is_error must be boolean`);
    flushUserText();
    const content = textContent(block.content, `${blockPath}.content`);
    call.resultSeen = true;
    output.push({
      role: "tool",
      content,
      toolCallId: id,
      toolName: call.name,
      ...(block.is_error === true ? { isError: true } : {}),
    });
  }
  flushUserText();
}

function parseMessages(value: unknown, beta: ReadonlySet<string>): ModelInputMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2_048)
    invalidRequest("messages must be a non-empty bounded array");
  const output: ModelInputMessage[] = [];
  const calls = new Map<string, { readonly name: string; resultSeen: boolean }>();
  let sawConversation = false;
  for (const [index, entry] of value.entries()) {
    const path = `messages[${index}]`;
    const message = object(entry, path);
    exactKeys(message, ["content", "role"], path, ["content", "role"]);
    const role = boundedString(message.role, `${path}.role`, 32);
    if (role === "system" && sawConversation && !beta.has("mid-conversation-system-2026-04-07"))
      unsupportedFeature("mid-conversation system messages require the pinned beta header");
    appendUserOrToolMessages(output, message, path, calls);
    if (role === "user" || role === "assistant") sawConversation = true;
  }
  if ([...calls.values()].some((call) => !call.resultSeen))
    invalidRequest("every tool_use must have exactly one later tool_result");
  return output;
}

export function parsePinnedAnthropicBetaHeader(value: string | undefined): ReadonlySet<string> | undefined {
  if (!value || value.length > 2_048) return undefined;
  const entries = value.split(",").map((entry) => entry.trim());
  if (!entries.length || entries.some((entry) => !entry || !pinnedAnthropicBetas.has(entry)))
    return undefined;
  if (new Set(entries).size !== entries.length) return undefined;
  return new Set(entries);
}

export function decodeMessagesRequest(
  value: unknown,
  expectedModelId: string,
  model: Model,
  beta: ReadonlySet<string>,
): DecodedMessagesRequest {
  const request = object(value, "request");
  exactKeys(
    request,
    ["max_tokens", "messages", "metadata", "model", "output_config", "stream", "system", "tools"],
    "request",
    ["max_tokens", "messages", "model", "output_config", "stream", "system", "tools"],
  );
  if (request.model !== expectedModelId) invalidRequest("model does not match the session binding");
  if (request.stream !== true) unsupportedFeature("only streaming Messages are supported");
  if (
    typeof request.max_tokens !== "number" ||
    !Number.isSafeInteger(request.max_tokens) ||
    request.max_tokens < 1 ||
    request.max_tokens > 1_000_000
  ) {
    invalidRequest("max_tokens must be a positive integer");
  }
  const outputConfig = object(request.output_config, "output_config");
  exactKeys(outputConfig, ["effort"], "output_config", ["effort"]);
  const effort = boundedString(outputConfig.effort, "output_config.effort", 16);
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort))
    unsupportedFeature("output_config.effort is not supported");
  if (effort !== model.options.reasoningLevel)
    unsupportedFeature("output_config.effort differs from the frozen Model binding");
  parseMetadata(request.metadata);
  const messages = parseMessages(request.messages, beta);
  const systemInstructions = parseSystem(request.system);
  const tools = parseTools(request.tools);
  const toolNames = new Set(tools.map((tool) => tool.name));
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!toolNames.has(call.name)) invalidRequest(`tool_use names an undefined tool: ${call.name}`);
    }
  }
  return {
    messages,
    ...(systemInstructions === undefined ? {} : { systemInstructions }),
    tools,
    model: expectedModelId,
    maxOutputTokens: request.max_tokens,
    effort: effort as DecodedMessagesRequest["effort"],
  };
}

export function messagesUsageIsValid(usage: ModelUsage | undefined): usage is ModelUsage {
  return (
    usage !== undefined &&
    Number.isSafeInteger(usage.inputTokens) &&
    (usage.inputTokens ?? -1) >= 0 &&
    Number.isSafeInteger(usage.outputTokens) &&
    (usage.outputTokens ?? -1) >= 0
  );
}
