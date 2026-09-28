function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function messageText(messages) {
  return messages.map((message) => contentText(message.content)).join("\n");
}

export function createFakeCodexGatewayModel(toolCommand) {
  const modelTrace = [];
  let cancellationStartedResolve;
  let cancellationObservedResolve;
  const cancellationStarted = new Promise((resolve) => {
    cancellationStartedResolve = resolve;
  });
  const cancellationObserved = new Promise((resolve) => {
    cancellationObservedResolve = resolve;
  });
  const model = {
    providerId: "fake-provider",
    modelId: "fake-model",
    displayName: "Loopback Fake Model",
    properties: { contextWindow: 16_000 },
    optionSpecs: { maxOutputTokens: { max: 4096 } },
    options: { reasoningLevel: "off" },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("probe uses streamText only");
    },
    async *streamText(request) {
      const text = messageText(request.messages);
      const hasToolResult = request.messages.some((message) => message.role === "tool");
      const kind = text.includes("wait until interrupted")
        ? "cancel"
        : hasToolResult
          ? "tool-result"
          : text.includes("invoke the local fixture writer")
            ? "tool-call"
            : "text";
      const usage =
        kind === "tool-call"
          ? { inputTokens: 12, outputTokens: 8, totalTokens: 20 }
          : kind === "cancel"
            ? undefined
            : { inputTokens: 12, outputTokens: 3, totalTokens: 15 };
      modelTrace.push({
        kind,
        messageCount: request.messages.length,
        toolCount: request.tools?.length ?? 0,
        abortSignalPassed: request.abortSignal instanceof AbortSignal,
        usage,
      });
      yield { type: "start" };
      if (kind === "cancel") {
        cancellationStartedResolve();
        const signal = request.abortSignal;
        if (signal?.aborted) {
          cancellationObservedResolve();
          return;
        }
        await new Promise((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        cancellationObservedResolve();
        return;
      }
      if (kind === "tool-call") {
        const args = JSON.stringify({ cmd: toolCommand });
        const callId = "call_gateway_fixture_write";
        yield {
          type: "tool_input_start",
          id: callId,
          toolName: "exec_command",
          providerExecuted: false,
        };
        const splitAt = Math.max(1, Math.floor(args.length / 2));
        yield { type: "tool_input_delta", id: callId, delta: args.slice(0, splitAt) };
        yield { type: "tool_input_delta", id: callId, delta: args.slice(splitAt) };
        yield { type: "tool_input_end", id: callId };
        yield {
          type: "tool_call",
          toolCall: {
            id: callId,
            name: "exec_command",
            input: { cmd: toolCommand },
            providerExecuted: false,
          },
        };
        yield { type: "finish", finishReason: "tool-calls", usage };
        return;
      }
      const reply = kind === "tool-result" ? "tool roundtrip ok" : "gateway text ok";
      const textId = "text_gateway_" + modelTrace.length;
      yield { type: "text_start", id: textId };
      yield { type: "text_delta", id: textId, text: reply };
      yield { type: "text_end", id: textId };
      yield { type: "finish", finishReason: "stop", usage };
    },
  };
  return { model, modelTrace, cancellationStarted, cancellationObserved };
}
