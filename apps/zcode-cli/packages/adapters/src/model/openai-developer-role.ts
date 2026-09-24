import {
  ModelErrorCode,
  ModelFailureReason,
  ModelProtocolError,
  modelMessageContentToText,
  type ModelInputMessage,
} from "@zcode/contracts";

type ProviderFetch = typeof globalThis.fetch;

type Instruction = Readonly<{ role: "system" | "developer"; content: string }>;
export type OpenAiInstructionPlan = readonly Instruction[];

function invalidDeveloperRole(message: string): ModelProtocolError {
  return new ModelProtocolError(ModelErrorCode.InvalidModelRequest, message, {
    reason: ModelFailureReason.InvalidRequest,
    retryable: false,
    source: "runtime",
  });
}

export function createOpenAiInstructionPlan(
  messages: readonly ModelInputMessage[],
  providerKind: string,
): OpenAiInstructionPlan | undefined {
  if (!messages.some((message) => message.role === "developer")) return undefined;
  if (providerKind !== "openai") {
    throw invalidDeveloperRole("Developer messages require a verified OpenAI Responses provider");
  }
  const instructions = messages
    .filter(
      (message): message is ModelInputMessage & { role: "system" | "developer" } =>
        message.role === "system" || message.role === "developer",
    )
    .map((message) => {
      if (message.toolCalls || message.toolCallId || message.toolName || message.isError) {
        throw invalidDeveloperRole("Instruction messages cannot contain tool fields");
      }
      if (
        typeof message.content !== "string" &&
        message.content.some((block) => block.type !== "text")
      ) {
        throw invalidDeveloperRole("Developer role requires text-only instruction messages");
      }
      return Object.freeze({
        role: message.role,
        content: modelMessageContentToText(message.content),
      });
    });
  return Object.freeze(instructions);
}

/**
 * SDK 6 将所有 instruction 当成 system；OpenAI Responses 的 SDK 转换只接受一个全局
 * systemMessageMode。这里先逐条核实 SDK 输出与原始有序计划完全一致，再仅恢复 developer
 * 的 wire role；不修改正文、不猜测优先级，也不触碰无 developer 的原生请求。
 */
export function createOpenAiDeveloperRoleFetch(
  fetch: ProviderFetch,
  plan: OpenAiInstructionPlan | undefined,
): ProviderFetch {
  if (!plan) return fetch;
  return async (request, init) => {
    const bodyText =
      typeof init?.body === "string"
        ? init.body
        : init?.body == null && request instanceof Request
          ? await request.clone().text()
          : undefined;
    if (!bodyText)
      throw invalidDeveloperRole("OpenAI Responses instruction body must be JSON text");
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      throw invalidDeveloperRole("OpenAI Responses instruction body is not JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw invalidDeveloperRole("OpenAI Responses instruction body is not an object");
    }
    const body = parsed as Record<string, unknown>;
    if (Object.hasOwn(body, "instructions") || !Array.isArray(body.input)) {
      throw invalidDeveloperRole("OpenAI Responses instruction layout is unsupported");
    }
    let position = 0;
    const input = body.input.map((entry: unknown) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return entry;
      const item = entry as Record<string, unknown>;
      if (item.role !== "system" && item.role !== "developer") return entry;
      const expected = plan[position++];
      if (
        !expected ||
        item.role !== "system" ||
        typeof item.content !== "string" ||
        item.content !== expected.content ||
        Object.keys(item).some((key) => key !== "role" && key !== "content")
      ) {
        throw invalidDeveloperRole("OpenAI Responses instruction layout differs from source roles");
      }
      return expected.role === "developer" ? { ...item, role: "developer" } : entry;
    });
    if (position !== plan.length) {
      throw invalidDeveloperRole("OpenAI Responses instruction count differs from source roles");
    }
    const patchedBody = JSON.stringify({ ...body, input });
    if (request instanceof Request) {
      return fetch(new Request(request, { ...init, body: patchedBody }));
    }
    return fetch(request, { ...init, body: patchedBody });
  };
}

export function requireOpenAiDeveloperSystemMode(
  providerOptions: Record<string, unknown> | undefined,
  hasDeveloper: boolean,
): Record<string, unknown> | undefined {
  if (!hasDeveloper) return providerOptions;
  const openai = providerOptions?.openai;
  if (openai !== undefined && (!openai || typeof openai !== "object" || Array.isArray(openai))) {
    throw invalidDeveloperRole("OpenAI provider options must be an object for developer messages");
  }
  const settings = (openai ?? {}) as Record<string, unknown>;
  if (settings.systemMessageMode !== undefined && settings.systemMessageMode !== "system") {
    throw invalidDeveloperRole("Developer messages require OpenAI systemMessageMode=system");
  }
  if (settings.instructions !== undefined) {
    throw invalidDeveloperRole("Developer messages cannot combine with OpenAI instructions option");
  }
  return { ...providerOptions, openai: { ...settings, systemMessageMode: "system" } };
}
