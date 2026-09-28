import type { Model, ModelRequest, ModelStreamEvent } from "@zcode/contracts";

export interface ClaudeHarnessFakeTrace {
  readonly userText: string;
  readonly messages: ModelRequest["messages"];
  readonly abortSignalPassed: boolean;
}

export interface ClaudeHarnessFakePaths {
  readonly workspace: string;
  readonly allowedWrite: string;
  readonly deniedWrite: string;
  readonly multiWriteA: string;
  readonly multiWriteB: string;
}

export function createClaudeHarnessFakeModel(input: {
  readonly routeId: string;
  readonly paths: ClaudeHarnessFakePaths;
  readonly routeChange?: {
    readonly started: Deferred<void>;
    readonly release: Deferred<void>;
  };
  readonly controls?: {
    readonly cancelStarted: Deferred<void>;
    readonly unknownStarted: Deferred<void>;
    readonly abortObserved: Deferred<void>;
  };
  readonly longLease?: {
    readonly started: Deferred<void>;
    readonly release: Deferred<void>;
  };
}) {
  const trace: ClaudeHarnessFakeTrace[] = [];
  let abortCount = 0;
  const model: Model = {
    providerId: "claude-fixture-provider",
    modelId: "claude-fixture-model",
    displayName: "Credential-free Claude Messages fixture",
    properties: { contextWindow: 32_768 },
    optionSpecs: { maxOutputTokens: { max: 32_768 } },
    options: { reasoningLevel: "low", maxOutputTokens: 32_768 },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("Claude Messages fixture uses streaming only");
    },
    async *streamText(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
      const lastUser = [...request.messages].reverse().find((message) => message.role === "user");
      const userText = lastUser ? messageText(lastUser.content) : "";
      trace.push({
        userText,
        messages: structuredClone(request.messages),
        abortSignalPassed: request.abortSignal instanceof AbortSignal,
      });
      yield {
        type: "start",
        usage: { inputTokens: 32 + request.messages.length, outputTokens: 0 },
      };

      if (userText.includes("WAIT_FOR_CANCEL") || userText.includes("WAIT_FOR_UNKNOWN")) {
        if (userText.includes("WAIT_FOR_CANCEL")) input.controls?.cancelStarted.resolve();
        if (userText.includes("WAIT_FOR_UNKNOWN")) input.controls?.unknownStarted.resolve();
        try {
          await new Promise<void>((resolve) =>
            request.abortSignal?.addEventListener("abort", resolve, { once: true }),
          );
        } finally {
          if (request.abortSignal?.aborted) {
            abortCount += 1;
            input.controls?.abortObserved.resolve();
          }
        }
        return;
      }

      if (userText.includes("LONG_LEASE_BINDING") && input.longLease) {
        input.longLease.started.resolve();
        await input.longLease.release.promise;
      }
      if (userText.includes("WAIT_FOR_ROUTE_CHANGE") && input.routeChange) {
        input.routeChange.started.resolve();
        await input.routeChange.release.promise;
      }

      const priorToolResults = request.messages.filter((message) => message.role === "tool");
      if (userText.includes("ALLOW_FIXED_WRITE") && priorToolResults.length === 0) {
        yield toolCall("toolu-allow", writeInput(input.paths.allowedWrite, "allowed"));
        yield finish("tool-calls", request.messages.length);
        return;
      }
      if (userText.includes("DENY_FIXED_WRITE") && priorToolResults.length === 0) {
        yield toolCall("toolu-deny", writeInput(input.paths.deniedWrite, "denied"));
        yield finish("tool-calls", request.messages.length);
        return;
      }
      if (userText.includes("RUN_TWO_TOOLS") && priorToolResults.length === 0) {
        yield toolCall("toolu-multi-a", writeInput(input.paths.multiWriteA, "alpha"));
        yield toolCall("toolu-multi-b", writeInput(input.paths.multiWriteB, "beta"));
        yield finish("tool-calls", request.messages.length);
        return;
      }
      if (userText.includes("DUPLICATE_NATIVE_TOOL_ID") && priorToolResults.length === 0) {
        yield toolCall("toolu-duplicate", writeInput(input.paths.deniedWrite, "duplicate"));
        yield toolCall("toolu-duplicate", writeInput(input.paths.deniedWrite, "duplicate"));
        yield finish("tool-calls", request.messages.length);
        return;
      }
      if (userText.includes("CHECK_TOOL_ENV") && priorToolResults.length === 0) {
        yield toolCall("toolu-env", {
          command:
            "if env | grep -E '^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CONFIG_DIR|ZCODE_CODEX_GATEWAY_TOKEN)=' >/dev/null; then printf leaked; else printf clean; fi",
        });
        yield finish("tool-calls", request.messages.length);
        return;
      }
      const text = priorToolResults.some((message) => message.isError)
        ? "tool denied safely"
        : priorToolResults.length
          ? "tool roundtrip complete"
          : `fake-${input.routeId}:${userText}`;
      yield { type: "text_start", id: `text-${trace.length}` };
      yield { type: "text_delta", id: `text-${trace.length}`, text };
      yield { type: "text_end", id: `text-${trace.length}` };
      yield finish("stop", request.messages.length);
    },
  };
  return { model, trace, get abortCount() { return abortCount; } };
}

function writeInput(path: string, value: string): Record<string, unknown> {
  return {
    command: `printf '%s' '${value}' >> '${path}'`,
    description: `Write the fixed ${value} fixture marker`,
    timeout: 10_000,
    run_in_background: false,
    dangerouslyDisableSandbox: false,
  };
}

function toolCall(id: string, input: Record<string, unknown>): ModelStreamEvent {
  return {
    type: "tool_call",
    toolCall: { id, name: "Bash", input, providerExecuted: false },
  };
}

function finish(reason: string, inputCount: number): ModelStreamEvent {
  return {
    type: "finish",
    finishReason: reason,
    usage: { inputTokens: 32 + inputCount, outputTokens: 8, totalTokens: 40 + inputCount },
  };
}

function messageText(content: ModelRequest["messages"][number]["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value?: T): void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {
    promise,
    resolve(value) {
      resolve(value as T);
    },
  };
}

export type ClaudeHarnessFakeModel = ReturnType<typeof createClaudeHarnessFakeModel>;
