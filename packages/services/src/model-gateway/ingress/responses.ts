import type { ModelInputMessage, ModelRequest, ModelToolContract } from "@zcode/contracts";
import {
  encodeResponsesStream,
  type GatewaySseFrame,
  type GatewayStreamContext,
} from "../egress/responses.js";
import type { ModelEvent } from "@zcode/contracts";

export class ResponsesCodecError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: 400 | 422,
    readonly field: string,
  ) {
    super(`${code}: ${field}`);
    this.name = "ResponsesCodecError";
  }
}

function fail(code: string, field: string, statusCode: 400 | 422 = 422): never {
  throw new ResponsesCodecError(code, statusCode, field);
}
function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("invalid_request", field, 400);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail("unsupported_parameter", `${field}.[unknown]`);
}
function string(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) fail("invalid_request", field, 400);
  return value;
}
function content(
  value: unknown,
  field: string,
  textType: "input_text" | "output_text" = "input_text",
): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) fail("unsupported_content", field);
  return value
    .map((part: unknown, index: number) => {
      if (
        !part ||
        typeof part !== "object" ||
        Array.isArray(part) ||
        (part as Record<string, unknown>).type !== textType
      )
        fail("unsupported_content", `${field}[${index}]`);
      const item = part as Record<string, unknown>;
      keys(item, ["type", "text"], `${field}[${index}]`);
      if (typeof item.text !== "string") fail("invalid_request", `${field}[${index}].text`, 400);
      return item.text;
    })
    .join("");
}
function argumentsObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "string") fail("invalid_tool_arguments", field, 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail("invalid_tool_arguments", field, 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    fail("invalid_tool_arguments", field, 400);
  return parsed as Record<string, unknown>;
}

/** Only the subset representable by ModelRequest is admitted. Core checks model alias and auth. */
export function decodeResponsesRequest(
  body: unknown,
  _headers: Readonly<Record<string, string | undefined>>,
): { request: ModelRequest; modelId: string; stream: true } {
  const input = record(body, "body");
  keys(
    input,
    [
      "model",
      "stream",
      "instructions",
      "input",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "store",
      "reasoning",
      "include",
      "client_metadata",
      "prompt_cache_key",
      "max_output_tokens",
    ],
    "body",
  );
  const modelId = string(input.model, "model");
  if (input.stream !== true) fail("unsupported_stream_mode", "stream");
  if (input.store !== undefined && input.store !== false) fail("unsupported_parameter", "store");
  if (input.parallel_tool_calls !== undefined && input.parallel_tool_calls !== true)
    fail("unsupported_parameter", "parallel_tool_calls");
  if (input.tool_choice !== undefined && input.tool_choice !== "auto")
    fail("unsupported_tool_choice", "tool_choice");
  if (input.reasoning !== undefined) {
    const reasoning = record(input.reasoning, "reasoning");
    keys(reasoning, ["effort"], "reasoning");
    if (reasoning.effort !== "none") fail("unsupported_reasoning", "reasoning.effort");
  }
  if (
    input.include !== undefined &&
    (!Array.isArray(input.include) ||
      input.include.some((part) => part !== "reasoning.encrypted_content") ||
      input.reasoning === undefined)
  )
    fail("unsupported_reasoning", "include");
  // With effort=none the encrypted reasoning projection is inert; any actual reasoning output fails in egress.
  if (input.client_metadata !== undefined) record(input.client_metadata, "client_metadata");
  let maxOutputTokens: number | undefined;
  if (input.max_output_tokens !== undefined) {
    if (!Number.isSafeInteger(input.max_output_tokens) || (input.max_output_tokens as number) < 1)
      fail("invalid_request", "max_output_tokens", 400);
    maxOutputTokens = input.max_output_tokens as number;
  }
  const messages: ModelInputMessage[] = [];
  if (input.instructions !== undefined)
    messages.push({ role: "system", content: string(input.instructions, "instructions") });
  const inputItems: unknown =
    typeof input.input === "string" ? [{ role: "user", content: input.input }] : input.input;
  if (!Array.isArray(inputItems)) fail("invalid_request", "input", 400);
  const calls = new Map<string, string>();
  const results = new Set<string>();
  for (const [index, raw] of inputItems.entries()) {
    const item = record(raw, `input[${index}]`);
    const field = `input[${index}]`;
    if (item.type === "reasoning") {
      keys(item, ["type", "id", "encrypted_content", "summary", "status"], field);
      if (item.status !== undefined && item.status !== "completed")
        fail("unsupported_reasoning", field);
      string(item.id, `${field}.id`);
      if (typeof item.encrypted_content !== "string" || !item.encrypted_content)
        fail("unsupported_reasoning", `${field}.encrypted_content`);
      if (!Array.isArray(item.summary)) fail("unsupported_reasoning", `${field}.summary`);
      for (const [partIndex, raw] of item.summary.entries()) {
        const part = record(raw, `${field}.summary[${partIndex}]`);
        keys(part, ["type", "text"], `${field}.summary[${partIndex}]`);
        if (part.type !== "summary_text" || typeof part.text !== "string")
          fail("unsupported_reasoning", `${field}.summary[${partIndex}]`);
      }
      // 修复原因：仅凭加密 item 无法证明当前 Model 仍是原始 provider route；
      // 跨路由或序列化投影可能静默丢掉私有状态，必须在调用 Model 前明确拒绝。
      fail("unsupported_reasoning_replay", field);
    } else if (item.type === "function_call") {
      keys(item, ["type", "id", "call_id", "name", "arguments", "status"], field);
      if (item.status !== undefined && item.status !== "completed")
        fail("unsupported_parameter", `${field}.status`);
      const id = string(item.call_id, `${field}.call_id`);
      if (calls.has(id)) fail("duplicate_tool_call", `${field}.call_id`, 400);
      const name = string(item.name, `${field}.name`);
      calls.set(id, name);
      messages.push({
        role: "assistant",
        content: "",
        toolCalls: [{ id, name, input: argumentsObject(item.arguments, `${field}.arguments`) }],
      });
    } else if (item.type === "function_call_output") {
      keys(item, ["type", "id", "call_id", "output", "status"], field);
      if (item.status !== undefined && item.status !== "completed")
        fail("unsupported_parameter", `${field}.status`);
      const id = string(item.call_id, `${field}.call_id`);
      const name = calls.get(id);
      if (!name || results.has(id)) fail("unpaired_tool_result", `${field}.call_id`, 400);
      results.add(id);
      messages.push({
        role: "tool",
        toolCallId: id,
        toolName: name,
        content: content(item.output, `${field}.output`),
      });
    } else {
      keys(item, ["type", "id", "role", "content", "status"], field);
      if (item.type !== undefined && item.type !== "message")
        fail("unsupported_content", `${field}.type`);
      if (item.status !== undefined && item.status !== "completed")
        fail("unsupported_parameter", `${field}.status`);
      if (
        item.role !== "system" &&
        item.role !== "developer" &&
        item.role !== "user" &&
        item.role !== "assistant"
      )
        fail("unsupported_content", `${field}.role`);
      messages.push({
        role: item.role,
        content: content(
          item.content,
          `${field}.content`,
          item.role === "assistant" ? "output_text" : "input_text",
        ),
      });
    }
  }
  if (
    input.prompt_cache_key !== undefined &&
    (typeof input.prompt_cache_key !== "string" ||
      !input.prompt_cache_key ||
      input.prompt_cache_key.length > 256)
  )
    fail("invalid_request", "prompt_cache_key", 400);
  let tools: ModelToolContract[] | undefined;
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) fail("invalid_request", "tools", 400);
    tools = input.tools.map((raw: unknown, index: number) => {
      const field = `tools[${index}]`;
      const tool = record(raw, field);
      if (tool.type !== "function") fail("unsupported_tool", `${field}.type`);
      keys(tool, ["type", "name", "description", "parameters", "strict"], field);
      const name = string(tool.name, `${field}.name`);
      if (tool.description !== undefined && typeof tool.description !== "string")
        fail("invalid_request", `${field}.description`, 400);
      if (tool.strict !== undefined && typeof tool.strict !== "boolean")
        fail("invalid_request", `${field}.strict`, 400);
      const schema = record(tool.parameters, `${field}.parameters`);
      return {
        name,
        description: tool.description as string | undefined,
        inputSchema: schema,
        strict: tool.strict as boolean | undefined,
      };
    });
    if (new Set(tools.map((tool) => tool.name)).size !== tools.length)
      fail("duplicate_tool", "tools", 400);
  }
  return {
    request: {
      messages,
      ...(input.prompt_cache_key !== undefined
        ? { promptCacheKey: input.prompt_cache_key as string }
        : {}),
      ...(tools ? { tools } : {}),
      ...(maxOutputTokens
        ? { options: { maxOutputTokens, reasoningLevel: "off" } }
        : { options: { reasoningLevel: "off" } }),
    },
    modelId,
    stream: true,
  };
}

export const responsesProtocol: {
  id: "responses";
  paths: readonly string[];
  decode: typeof decodeResponsesRequest;
  encode: (
    events: AsyncIterable<ModelEvent>,
    context: GatewayStreamContext,
  ) => AsyncIterable<GatewaySseFrame>;
} = {
  id: "responses",
  paths: ["/v1/responses"],
  decode: decodeResponsesRequest,
  encode: encodeResponsesStream,
};
