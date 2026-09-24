import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Model as PiModel,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Usage,
  type Provider,
} from "@earendil-works/pi-ai";
import type { Model as ZCodeModel, ModelInputMessage, ModelStreamEvent } from "@zcode/contracts";

const HOST_PROVIDER_ID = "zcode-host";
const HOST_API = "zcode-model-executor";
const EMPTY_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

function toMessages(context: TranscriptContext): ModelInputMessage[] {
  const systems = context.messages.filter((message) => message.role === "system");
  if (systems.length > 1)
    throw new Error("mid-conversation system updates are not certified for this Pi bridge");
  const messages: ModelInputMessage[] = [];
  if (systems.length)
    messages.push({ role: "system", content: getCurrentSystemPrompt(context.messages) });
  for (const message of context.messages) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      if (typeof message.content === "string")
        messages.push({ role: "user", content: message.content });
      else {
        if (message.content.some((part) => part.type !== "text"))
          throw new Error("Pi image input is not certified for host-managed routing");
        messages.push({
          role: "user",
          content: message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("\n"),
        });
      }
    } else if (message.role === "assistant") {
      if (
        message.content.some(
          (part) =>
            (part.type === "thinking" && (part.thinkingSignature || part.redacted)) ||
            (part.type === "text" && part.textSignature) ||
            (part.type === "toolCall" && (part.thoughtSignature || part.namespace)),
        )
      ) {
        throw new Error(
          "opaque provider signature or tool namespace cannot be migrated across model routes",
        );
      }
      messages.push({
        role: "assistant",
        content: message.content
          .filter((part) => part.type !== "toolCall")
          .map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : { type: "reasoning" as const, text: part.thinking },
          ),
        toolCalls: message.content
          .filter((part) => part.type === "toolCall")
          .map((part) => ({
            id: part.type === "toolCall" ? part.id : "",
            name: part.type === "toolCall" ? part.name : "",
            input: part.type === "toolCall" ? part.arguments : {},
          })),
      });
    } else if (message.role === "toolResult") {
      if (message.content.some((part) => part.type !== "text"))
        throw new Error("image tool results not certified");
      messages.push({
        role: "tool",
        content: message.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"),
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        isError: message.isError,
      });
    } else {
      throw new Error("unsupported Pi context message role");
    }
  }
  return messages;
}

function toUsage(usage: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}): Usage {
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    reasoning: usage.reasoningTokens,
    totalTokens: usage.totalTokens ?? input + output,
    cost: { ...EMPTY_COST },
  };
}

export function createPiHostProvider(model: ZCodeModel): Provider {
  const modelId = `${model.providerId}/${model.modelId}`;
  const piModel: PiModel<typeof HOST_API> = {
    id: modelId,
    name: model.displayName ?? modelId,
    api: HOST_API,
    provider: HOST_PROVIDER_ID,
    baseUrl: "zcode-model-executor://local",
    reasoning: false,
    input: ["text"],
    cost: { ...EMPTY_COST },
    contextWindow: model.properties.contextWindow,
    maxTokens: model.optionSpecs.maxOutputTokens.max,
  };
  const streamSimple = (
    _selected: PiModel<typeof HOST_API>,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const response: AssistantMessage = {
        role: "assistant",
        api: HOST_API,
        provider: HOST_PROVIDER_ID,
        model: modelId,
        content: [],
        timestamp: Date.now(),
        stopReason: "pending",
        usage: toUsage({}),
      };
      let started = false;
      let finished = false;
      let failureStage = "validate-context";
      const textIndexes = new Map<string, number>();
      const toolIndexes = new Map<string, number>();
      const toolInputs = new Map<string, string>();
      const reasoningIndexes = new Map<string, number>();
      try {
        if (_selected.id !== modelId) throw new Error("Pi requested a different model route");
        if (options?.toolChoice && options.toolChoice !== "auto")
          throw new Error("non-auto tool choice is not supported by the ZCode model executor");
        const messages = toMessages(context);
        failureStage = "prepare-tools";
        const tools = getCurrentTools(context.messages).map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.parameters as Record<string, unknown>,
        }));
        const payload = {
          messages,
          tools,
          options: {
            reasoningLevel: model.options.reasoningLevel,
            maxOutputTokens: options?.maxTokens ?? model.optionSpecs.maxOutputTokens.max,
          },
        };
        failureStage = "payload-hook";
        const originalPayload = JSON.stringify(payload);
        const replacement = await options?.onPayload?.(payload, _selected);
        if (
          JSON.stringify(payload) !== originalPayload ||
          (replacement !== undefined && JSON.stringify(replacement) !== originalPayload)
        ) {
          throw new Error("provider payload mutation is not supported by this host-managed bridge");
        }
        failureStage = "executor-stream";
        for await (const event of model.streamText({ ...payload, abortSignal: options?.signal })) {
          if (!started) {
            started = true;
            stream.push({ type: "start", partial: response });
            await options?.onResponse?.({ status: 200, headers: {} }, _selected);
          }
          convertEvent(event);
          if (finished) break;
        }
        if (!finished) throw new Error("ZCode model stream ended without a finish event");
      } catch {
        response.stopReason = options?.signal?.aborted ? "aborted" : "error";
        response.errorMessage = `ZCode model bridge failed at ${failureStage}; inspect target-host diagnostics`;
        stream.push({ type: "error", reason: response.stopReason, error: response });
      }
      function convertEvent(event: ModelStreamEvent): void {
        switch (event.type) {
          case "text_start": {
            const index = response.content.push({ type: "text", text: "" }) - 1;
            textIndexes.set(event.id, index);
            stream.push({ type: "text_start", contentIndex: index, partial: response });
            break;
          }
          case "text_delta": {
            const index = event.id ? textIndexes.get(event.id) : [...textIndexes.values()].at(-1);
            const part = index !== undefined && response.content[index];
            if (!part || part.type !== "text") throw new Error("text delta without text_start");
            part.text += event.text;
            stream.push({
              type: "text_delta",
              contentIndex: index,
              delta: event.text,
              partial: response,
            });
            break;
          }
          case "text_end": {
            const index = textIndexes.get(event.id);
            const part = index !== undefined && response.content[index];
            if (!part || part.type !== "text") throw new Error("text_end without text_start");
            stream.push({
              type: "text_end",
              contentIndex: index,
              content: part.text,
              partial: response,
            });
            break;
          }
          case "tool_input_start": {
            const index =
              response.content.push({
                type: "toolCall",
                id: event.id,
                name: event.toolName,
                arguments: {},
              }) - 1;
            toolIndexes.set(event.id, index);
            toolInputs.set(event.id, "");
            stream.push({ type: "toolcall_start", contentIndex: index, partial: response });
            break;
          }
          case "tool_input_delta": {
            if (!toolInputs.has(event.id)) throw new Error("tool delta without start");
            toolInputs.set(event.id, toolInputs.get(event.id)! + event.delta);
            const index = toolIndexes.get(event.id)!;
            stream.push({
              type: "toolcall_delta",
              contentIndex: index,
              delta: event.delta,
              partial: response,
            });
            break;
          }
          case "tool_call": {
            const { id, name, input } = event.toolCall;
            const index = toolIndexes.get(id);
            if (
              index === undefined ||
              typeof input !== "object" ||
              input === null ||
              Array.isArray(input)
            )
              throw new Error("invalid completed tool call");
            // 修复：AI SDK 的展示 delta 可能是不完整 JSON；只有最终 tool_call.input 是已提交且校验后的执行输入。
            // Pi 仍接收增量供 UI 展示，但执行仅消费最终对象，不从增量猜测参数。
            if (!toolInputs.has(id)) throw new Error("tool call without input start");
            if (event.toolCall.providerExecuted)
              throw new Error("provider-executed tool cannot be approved before execution");
            const part = response.content[index];
            if (!part || part.type !== "toolCall" || part.name !== name)
              throw new Error("tool call identity mismatch");
            part.arguments = input as Record<string, never>;
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall: part,
              partial: response,
            });
            toolIndexes.delete(id);
            toolInputs.delete(id);
            break;
          }
          case "finish": {
            if (toolIndexes.size || reasoningIndexes.size)
              throw new Error("unfinished tool or reasoning input in model stream");
            const reason =
              event.finishReason === "stop"
                ? "stop"
                : event.finishReason === "length"
                  ? "length"
                  : event.finishReason === "tool-calls"
                    ? "toolUse"
                    : undefined;
            if (!reason) throw new Error("unsupported model finish reason");
            response.stopReason = reason;
            response.usage = toUsage(event.usage);
            finished = true;
            stream.push({ type: "done", reason, message: response });
            break;
          }
          case "reasoning_start": {
            // 修复：实际 Provider 即使请求 off 仍会发送普通 reasoning；Pi 与现有 Model 契约都能表达文本，不能在首个工具前误报失败。
            if (event.providerMetadata && Object.keys(event.providerMetadata).length)
              throw new Error("opaque reasoning metadata cannot be represented");
            const index = response.content.push({ type: "thinking", thinking: "" }) - 1;
            reasoningIndexes.set(event.id, index);
            stream.push({ type: "thinking_start", contentIndex: index, partial: response });
            break;
          }
          case "reasoning_delta": {
            const index = event.id
              ? reasoningIndexes.get(event.id)
              : [...reasoningIndexes.values()].at(-1);
            const part = index === undefined ? undefined : response.content[index];
            if (
              index === undefined ||
              !part ||
              part.type !== "thinking" ||
              (event.providerMetadata && Object.keys(event.providerMetadata).length)
            )
              throw new Error("unrepresentable reasoning delta");
            part.thinking += event.text;
            stream.push({
              type: "thinking_delta",
              contentIndex: index,
              delta: event.text,
              partial: response,
            });
            break;
          }
          case "reasoning_end": {
            const index = reasoningIndexes.get(event.id);
            const part = index === undefined ? undefined : response.content[index];
            if (
              index === undefined ||
              !part ||
              part.type !== "thinking" ||
              (event.providerMetadata && Object.keys(event.providerMetadata).length)
            )
              throw new Error("unrepresentable reasoning end");
            stream.push({
              type: "thinking_end",
              contentIndex: index,
              content: part.thinking,
              partial: response,
            });
            reasoningIndexes.delete(event.id);
            break;
          }
          case "error":
            throw new Error("ZCode model stream error", { cause: event.error });
          case "start":
          case "tool_input_end":
          case "compact_stream_boundary":
            break;
        }
      }
    })();
    return stream;
  };
  const provider: Provider<typeof HOST_API> = {
    id: HOST_PROVIDER_ID,
    name: "ZCode Model Executor",
    auth: {
      apiKey: {
        name: "Host session",
        resolve: async () => ({
          auth: { apiKey: "session-scoped-internal" },
          source: "ZCode host",
        }),
      },
    },
    getModels: () => [piModel],
    stream: (selected, context, options) =>
      streamSimple(selected, context, options as SimpleStreamOptions),
    streamSimple,
  };
  return provider;
}
