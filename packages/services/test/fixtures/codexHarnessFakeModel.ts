import type { Model, ModelRequest, ModelStreamEvent } from "@zcode/contracts";

export interface CodexFakeModelTrace {
  readonly userText: string;
  readonly messages: ModelRequest["messages"];
  readonly toolOutputs: string[];
  readonly abortSignalPassed: boolean;
}

export function createCodexHarnessFakeModel(paths: {
  allow: string;
  deny: string;
  race?: string;
  longTool?: { script: string; release: string; started: string; finished: string };
}) {
  const trace: CodexFakeModelTrace[] = [];
  const cancelStarts: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  const cancelObservations: Array<{ promise: Promise<void>; resolve: () => void }> = [];
  let cancelCount = 0;
  const waitForCancelStart = (index: number) => cancellationPromise(cancelStarts, index).promise;
  const waitForCancelObserved = (index: number) =>
    cancellationPromise(cancelObservations, index).promise;
  const model = {
    providerId: "fake-provider",
    modelId: "fake-model",
    displayName: "Credential-free Codex fixture model",
    properties: { contextWindow: 16_000 },
    optionSpecs: { maxOutputTokens: { max: 4096 } },
    options: { reasoningLevel: "off" },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("Codex fixture uses streaming only");
    },
    async *streamText(request: ModelRequest) {
      const lastUserIndex = request.messages.findLastIndex((message) => message.role === "user");
      const userText =
        lastUserIndex < 0 ? "" : messageText(request.messages[lastUserIndex]!.content);
      const toolOutputs = request.messages
        .slice(lastUserIndex + 1)
        .filter((message) => message.role === "tool")
        .map((message) => messageText(message.content));
      trace.push({
        userText,
        messages: structuredClone(request.messages),
        toolOutputs,
        abortSignalPassed: request.abortSignal instanceof AbortSignal,
      });
      yield { type: "start", modelId: "fake-model" } satisfies ModelStreamEvent;
      if (userText.includes("WAIT_FOR_CANCEL")) {
        const index = ++cancelCount;
        cancellationPromise(cancelStarts, index).resolve();
        if (!request.abortSignal?.aborted) {
          await new Promise<void>((resolve) =>
            request.abortSignal?.addEventListener("abort", resolve, { once: true }),
          );
        }
        cancellationPromise(cancelObservations, index).resolve();
        return;
      }
      if (toolOutputs.length) {
        yield* textEvents("tool roundtrip ok", `text_after_tools_${trace.length}`);
        yield {
          type: "finish",
          finishReason: "stop",
          usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 },
        } satisfies ModelStreamEvent;
        return;
      }
      if (userText.includes("LONG_TOOL") && paths.longTool) {
        const command = `node '${paths.longTool.script}' '${paths.longTool.release}' '${paths.longTool.started}' '${paths.longTool.finished}'`;
        yield* toolEvents([{ id: "call_long_tool", cmd: command }]);
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        } satisfies ModelStreamEvent;
        return;
      }
      if (userText.includes("RUN_MULTI_TOOLS")) {
        yield* textEvents("Running two fixed local commands.", "text_multi");
        yield* toolEvents([
          { id: "call_multi_a", cmd: "printf alpha > multi-a.txt" },
          { id: "call_multi_b", cmd: "printf beta > multi-b.txt" },
        ]);
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        } satisfies ModelStreamEvent;
        return;
      }
      if (userText.includes("ALLOW_FIXED_WRITE")) {
        yield* toolEvents([
          { id: "call_approved_write", cmd: `printf approved > '${paths.allow}'` },
        ]);
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        } satisfies ModelStreamEvent;
        return;
      }
      if (userText.includes("DENY_FIXED_WRITE")) {
        yield* toolEvents([{ id: "call_denied_write", cmd: `printf denied > '${paths.deny}'` }]);
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        } satisfies ModelStreamEvent;
        return;
      }
      if (userText.includes("RACE_FIXED_WRITE") && paths.race) {
        yield* toolEvents([{ id: "call_raced_write", cmd: `printf raced > '${paths.race}'` }]);
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        } satisfies ModelStreamEvent;
        return;
      }
      if (userText.includes("CHECK_TOKEN_ISOLATION")) {
        yield* toolEvents([
          {
            id: "call_token_check",
            cmd: 'if [ -n "${ZCODE_CODEX_GATEWAY_TOKEN-}" ]; then printf token-exposed; else printf token-absent; fi',
          },
        ]);
        yield {
          type: "finish",
          finishReason: "tool-calls",
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        } satisfies ModelStreamEvent;
        return;
      }
      yield* textEvents("gateway text ok", `text_default_${trace.length}`);
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      } satisfies ModelStreamEvent;
    },
  };
  return { model: model as unknown as Model, trace, waitForCancelStart, waitForCancelObserved };
}

function* textEvents(text: string, id: string): Generator<ModelStreamEvent> {
  yield { type: "text_start", id };
  yield { type: "text_delta", id, text };
  yield { type: "text_end", id };
}

function* toolEvents(calls: readonly { id: string; cmd: string }[]): Generator<ModelStreamEvent> {
  for (const call of calls) {
    const input = { cmd: call.cmd };
    const argumentsText = JSON.stringify(input);
    const split = Math.max(1, Math.floor(argumentsText.length / 2));
    yield {
      type: "tool_input_start",
      id: call.id,
      toolName: "exec_command",
      providerExecuted: false,
    };
    yield { type: "tool_input_delta", id: call.id, delta: argumentsText.slice(0, split) };
    yield { type: "tool_input_delta", id: call.id, delta: argumentsText.slice(split) };
    yield { type: "tool_input_end", id: call.id };
    yield {
      type: "tool_call",
      toolCall: { id: call.id, name: "exec_command", input, providerExecuted: false },
    };
  }
}

function messageText(content: ModelRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function cancellationPromise(
  entries: Array<{ promise: Promise<void>; resolve: () => void }>,
  index: number,
): { promise: Promise<void>; resolve: () => void } {
  while (entries.length < index) {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    entries.push({ promise, resolve });
  }
  return entries[index - 1]!;
}
