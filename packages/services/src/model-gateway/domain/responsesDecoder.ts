import type { JsonSchema, ModelInputMessage, ModelToolContract } from "@zcode/contracts";
import { invalidRequest, unsupportedFeature } from "./errors.js";

export interface DecodedResponsesRequest {
  readonly messages: ModelInputMessage[];
  readonly systemInstructions?: string;
  readonly tools: ModelToolContract[];
  readonly model: string;
  readonly clientSessionId: string;
  readonly clientThreadId: string;
  readonly promptCacheKey?: string;
  readonly parallelToolCalls: boolean;
  readonly maxOutputTokens?: number;
}

const requestKeys = [
  "client_metadata",
  "include",
  "input",
  "instructions",
  "max_output_tokens",
  "model",
  "parallel_tool_calls",
  "prompt_cache_key",
  "reasoning",
  "store",
  "stream",
  "tool_choice",
  "tools",
];
const metadataKeys = [
  "root_turn_id",
  "session_id",
  "thread_id",
  "turn_id",
  "x-codex-installation-id",
  "x-codex-turn-metadata",
  "x-codex-window-id",
];

type JsonObject = Record<string, unknown>;

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

function string(value: unknown, path: string, maxLength = 1_000_000): string {
  if (typeof value !== "string" || value.length > maxLength)
    invalidRequest(`${path} must be a bounded string`);
  return value;
}

function textContent(value: unknown, role: string, path: string): ModelInputMessage["content"] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) unsupportedFeature(`${path} must contain text only`);
  const expectedType = role === "assistant" ? "output_text" : "input_text";
  return value.map((part, index) => {
    const currentPath = `${path}[${index}]`;
    const record = object(part, currentPath);
    exactKeys(record, ["text", "type"], currentPath, ["text", "type"]);
    if (record.type !== expectedType)
      unsupportedFeature(`${currentPath}.type is not supported for ${role}`);
    return { type: "text" as const, text: string(record.text, `${currentPath}.text`) };
  });
}

function parseToolDefinitions(value: unknown): ModelToolContract[] {
  if (!Array.isArray(value) || value.length > 256) invalidRequest("tools must be a bounded array");
  const names = new Set<string>();
  return value.map((entry, index) => {
    const path = `tools[${index}]`;
    const tool = object(entry, path);
    exactKeys(tool, ["description", "name", "parameters", "strict", "type"], path, [
      "name",
      "parameters",
      "type",
    ]);
    if (tool.type !== "function") unsupportedFeature(`${path}.type is not supported`);
    const name = string(tool.name, `${path}.name`, 128);
    if (!name || names.has(name)) invalidRequest(`${path}.name must be non-empty and unique`);
    names.add(name);
    if (tool.description !== undefined) string(tool.description, `${path}.description`, 16_000);
    if (tool.strict !== undefined && typeof tool.strict !== "boolean")
      invalidRequest(`${path}.strict must be boolean`);
    const schema = object(tool.parameters, `${path}.parameters`) as JsonSchema;
    return {
      name,
      ...(tool.description === undefined ? {} : { description: tool.description as string }),
      inputSchema: schema,
      ...(tool.strict === undefined ? {} : { strict: tool.strict as boolean }),
    };
  });
}

function parseMessage(item: JsonObject, index: number): ModelInputMessage {
  const path = `input[${index}]`;
  exactKeys(item, ["content", "id", "role", "type"], path, ["content", "role", "type"]);
  if (item.type !== "message") unsupportedFeature(`${path}.type is not supported`);
  if (item.id !== undefined) string(item.id, `${path}.id`, 256);
  const role = string(item.role, `${path}.role`, 32);
  if (role === "system" || role === "developer" || role === "user" || role === "assistant") {
    return { role, content: textContent(item.content, role, `${path}.content`) };
  }
  return unsupportedFeature(`${path}.role is not supported`);
}

function parseInput(value: unknown): {
  messages: ModelInputMessage[];
  systemInstructions: string[];
} {
  const messages: ModelInputMessage[] = [];
  const systemInstructions: string[] = [];
  if (typeof value === "string") {
    messages.push({ role: "user", content: value });
    return { messages, systemInstructions };
  }
  if (!Array.isArray(value) || value.length > 2_048)
    invalidRequest("input must be text or a bounded item array");
  const calls = new Map<string, { name: string; outputSeen: boolean }>();
  let sawConversationInput = false;
  let callBatch: NonNullable<ModelInputMessage["toolCalls"]> = [];
  const flushCallBatch = () => {
    if (callBatch.length === 0) return;
    const previous = messages.at(-1);
    // 修复依据：Responses 同轮可先输出 assistant 可见文本再输出相邻 function_call；保留文本并把 calls 合并到同一 Model assistant 项。
    if (previous?.role === "assistant" && previous.toolCalls === undefined) {
      previous.toolCalls = callBatch;
    } else {
      messages.push({ role: "assistant", content: "", toolCalls: callBatch });
    }
    callBatch = [];
  };
  for (const [index, entry] of value.entries()) {
    const path = `input[${index}]`;
    const item = object(entry, path);
    if (item.type === "message") {
      const message = parseMessage(item, index);
      if (message.role === "system") {
        if (sawConversationInput) {
          unsupportedFeature("system messages must precede conversation input");
        }
        systemInstructions.push(
          typeof message.content === "string"
            ? message.content
            : message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n\n"),
        );
      } else {
        flushCallBatch();
        sawConversationInput = true;
        messages.push(message);
      }
      continue;
    }
    if (item.type === "function_call") {
      exactKeys(item, ["arguments", "call_id", "id", "name", "type"], path, [
        "arguments",
        "call_id",
        "name",
        "type",
      ]);
      if (item.id !== undefined) string(item.id, `${path}.id`, 256);
      const callId = string(item.call_id, `${path}.call_id`, 256);
      const name = string(item.name, `${path}.name`, 128);
      const argsText = string(item.arguments, `${path}.arguments`, 1_000_000);
      if (!callId || !name || calls.has(callId))
        invalidRequest(`${path} has an invalid or duplicate call_id`);
      let input: unknown;
      try {
        input = JSON.parse(argsText);
      } catch {
        invalidRequest(`${path}.arguments must be valid JSON`);
      }
      if (input === null || typeof input !== "object" || Array.isArray(input))
        invalidRequest(`${path}.arguments must decode to an object`);
      calls.set(callId, { name, outputSeen: false });
      sawConversationInput = true;
      callBatch.push({ id: callId, name, input });
      continue;
    }
    if (item.type === "function_call_output") {
      flushCallBatch();
      exactKeys(item, ["call_id", "id", "output", "type"], path, ["call_id", "output", "type"]);
      if (item.id !== undefined) string(item.id, `${path}.id`, 256);
      const callId = string(item.call_id, `${path}.call_id`, 256);
      const call = calls.get(callId);
      if (!call || call.outputSeen)
        invalidRequest(`${path}.call_id has no unmatched function call`);
      const output = string(item.output, `${path}.output`);
      call.outputSeen = true;
      sawConversationInput = true;
      messages.push({ role: "tool", content: output, toolCallId: callId, toolName: call.name });
      continue;
    }
    return unsupportedFeature(`${path}.type is not supported`);
  }
  flushCallBatch();
  if ([...calls.values()].some((call) => !call.outputSeen))
    invalidRequest("every input function_call must have one later function_call_output");
  return { messages, systemInstructions };
}

function parseClientMetadata(value: unknown): { sessionId: string; threadId: string } {
  const metadata = object(value, "client_metadata");
  exactKeys(metadata, metadataKeys, "client_metadata", ["session_id", "thread_id"]);
  for (const [key, entry] of Object.entries(metadata)) {
    const maxLength = key === "x-codex-turn-metadata" ? 16_384 : 512;
    const text = string(entry, `client_metadata.${key}`, maxLength);
    if (!text) invalidRequest(`client_metadata.${key} must not be empty`);
  }
  return { sessionId: metadata.session_id as string, threadId: metadata.thread_id as string };
}

export function decodeResponsesRequest(
  value: unknown,
  expectedModelId: string,
): DecodedResponsesRequest {
  const request = object(value, "request");
  exactKeys(request, requestKeys, "request", [
    "client_metadata",
    "input",
    "model",
    "parallel_tool_calls",
    "reasoning",
    "store",
    "stream",
    "tool_choice",
    "tools",
  ]);
  if (request.model !== expectedModelId) invalidRequest("model does not match the session binding");
  if (request.stream !== true) unsupportedFeature("only streaming Responses are supported");
  if (request.store !== false) unsupportedFeature("Responses storage is not supported");
  if (request.tool_choice !== "auto")
    unsupportedFeature("only automatic function tool choice is supported");
  if (typeof request.parallel_tool_calls !== "boolean")
    invalidRequest("parallel_tool_calls must be boolean");
  if (request.parallel_tool_calls === false) {
    unsupportedFeature(
      "parallel_tool_calls=false cannot be enforced by the shared Model request contract",
    );
  }
  const reasoning = object(request.reasoning, "reasoning");
  exactKeys(reasoning, ["effort"], "reasoning", ["effort"]);
  if (reasoning.effort !== "none") unsupportedFeature("only reasoning effort none is supported");
  if (request.include !== undefined) {
    if (!Array.isArray(request.include) || request.include.length > 1)
      invalidRequest("include must be a bounded array");
    if (request.include.some((entry) => entry !== "reasoning.encrypted_content"))
      unsupportedFeature("requested include value is not supported");
    if (request.include.length && reasoning.effort !== "none")
      unsupportedFeature("encrypted reasoning include requires reasoning effort none");
  }
  const metadata = parseClientMetadata(request.client_metadata);
  const cacheKey =
    request.prompt_cache_key === undefined
      ? undefined
      : string(request.prompt_cache_key, "prompt_cache_key", 128);
  if (cacheKey !== undefined && !cacheKey) invalidRequest("prompt_cache_key must not be empty");
  const topLevelInstructions =
    request.instructions === undefined ? undefined : string(request.instructions, "instructions");
  const tools = parseToolDefinitions(request.tools);
  const maxOutputTokens = request.max_output_tokens;
  if (
    maxOutputTokens !== undefined &&
    (typeof maxOutputTokens !== "number" ||
      !Number.isSafeInteger(maxOutputTokens) ||
      maxOutputTokens < 1 ||
      maxOutputTokens > 1_000_000)
  ) {
    invalidRequest("max_output_tokens must be a positive integer");
  }
  const parsedInput = parseInput(request.input);
  const systemInstructionParts = [
    ...(topLevelInstructions === undefined ? [] : [topLevelInstructions]),
    ...parsedInput.systemInstructions,
  ];
  return {
    messages: parsedInput.messages,
    ...(systemInstructionParts.length > 0
      ? { systemInstructions: systemInstructionParts.join("\n\n") }
      : {}),
    tools,
    model: expectedModelId,
    clientSessionId: metadata.sessionId,
    clientThreadId: metadata.threadId,
    ...(cacheKey === undefined ? {} : { promptCacheKey: cacheKey }),
    parallelToolCalls: request.parallel_tool_calls,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  };
}
