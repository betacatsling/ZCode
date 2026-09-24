import {
  createAssistantMessageEventStream,
  getCurrentSystemPrompt,
  getCurrentTools,
  type AssistantMessage,
  type Model as PiModel,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Provider,
} from "@earendil-works/pi-ai";
import type { Model as ZCodeModel, ModelInputMessage, ModelStreamEvent } from "@zcode/contracts";
import type { CapturedHostModel } from "../../agent-host/modelBinding.js";
import type { ReasoningMetadata } from "./piReasoningSignature.js";

// Pi's source worker loads .ts directly; the packaged worker loads compiled .js.
const sourceMode = import.meta.url.endsWith(".ts");
const { EMPTY_COST, toUsage } = await import(
  sourceMode ? "./piModelUsage.ts" : "./piModelUsage.js"
);
const {
  HOST_API,
  HOST_PROVIDER_ID,
  SIGNATURE_KIND,
  appendReasoningMetadata,
  metadataFailure,
  readSignature,
} = await import(sourceMode ? "./piReasoningSignature.ts" : "./piReasoningSignature.js");

function toMessages(
  context: TranscriptContext,
  model: ZCodeModel,
  route?: CapturedHostModel["identity"],
): ModelInputMessage[] {
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
            (part.type === "thinking" && part.redacted && !part.thinkingSignature) ||
            (part.type === "text" && part.textSignature) ||
            (part.type === "toolCall" && (part.thoughtSignature || part.namespace)),
        )
      ) {
        throw new Error("unsupported provider signature or tool namespace in Pi history");
      }
      messages.push({
        role: "assistant",
        providerId: model.providerId,
        modelId: model.modelId,
        content: message.content
          .filter((part) => part.type !== "toolCall")
          .map((part) =>
            part.type === "text"
              ? { type: "text" as const, text: part.text }
              : {
                  type: "reasoning" as const,
                  text: part.redacted ? "" : part.thinking,
                  ...(part.thinkingSignature
                    ? {
                        providerOptions: readSignature(
                          part.thinkingSignature,
                          message,
                          model,
                          route,
                        ),
                      }
                    : {}),
                },
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

export function createPiHostProvider(
  model: ZCodeModel,
  route?: CapturedHostModel["identity"],
): Provider {
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
      const reasoningSignatures = new Map<number, ReasoningMetadata>();
      try {
        if (_selected.id !== modelId) throw new Error("Pi requested a different model route");
        if (options?.toolChoice && options.toolChoice !== "auto")
          throw new Error("non-auto tool choice is not supported by the ZCode model executor");
        const messages = toMessages(context, model, route);
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
      } catch (error) {
        response.stopReason = options?.signal?.aborted ? "aborted" : "error";
        response.errorMessage =
          error instanceof Error &&
          (error.message.startsWith("unsupported reasoning metadata field ") ||
            error.message === "reasoning signature route mismatch" ||
            error.message === "reasoning signature route identity unavailable")
            ? error.message
            : `ZCode model bridge failed at ${failureStage}; inspect target-host diagnostics`;
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
            const index = response.content.push({ type: "thinking", thinking: "" }) - 1;
            appendReasoningMetadata(reasoningSignatures, index, event.providerMetadata);
            if (reasoningSignatures.get(index)?.anthropic.redactedData !== undefined) {
              const part = response.content[index];
              if (part?.type === "thinking") part.redacted = true;
            }
            reasoningIndexes.set(event.id, index);
            stream.push({ type: "thinking_start", contentIndex: index, partial: response });
            break;
          }
          case "reasoning_delta": {
            const index = event.id
              ? reasoningIndexes.get(event.id)
              : [...reasoningIndexes.values()].at(-1);
            const part = index === undefined ? undefined : response.content[index];
            if (index === undefined || !part || part.type !== "thinking")
              throw new Error("unrepresentable reasoning delta");
            appendReasoningMetadata(reasoningSignatures, index, event.providerMetadata);
            if (part.redacted && event.text)
              metadataFailure("anthropic.redactedData.text", event.text);
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
            if (index === undefined || !part || part.type !== "thinking")
              throw new Error("unrepresentable reasoning end");
            appendReasoningMetadata(reasoningSignatures, index, event.providerMetadata);
            const metadata = reasoningSignatures.get(index);
            if (metadata) {
              if (!route) throw new Error("reasoning signature route identity unavailable");
              if (route.providerId !== model.providerId || route.modelId !== model.modelId)
                throw new Error("reasoning signature route mismatch");
              // 修复：SDK 的 signature_delta 是空文本增量；必须留在原生 thinkingSignature，
              // 才能在工具执行后原样带回同一路由的 Model providerOptions。
              part.thinkingSignature = JSON.stringify({
                v: 1,
                kind: SIGNATURE_KIND,
                providerId: route.providerId,
                modelId: route.modelId,
                apiType: route.apiType,
                endpointFingerprint: route.endpointFingerprint,
                providerMetadata: metadata,
              });
              part.redacted = metadata.anthropic.redactedData !== undefined;
            }
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
