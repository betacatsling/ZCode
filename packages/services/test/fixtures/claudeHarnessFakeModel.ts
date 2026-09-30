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
    providerId: "claude-fixture-provider" as Model["providerId"],
    modelId: "claude-fixture-model" as Model["modelId"],
    displayName: "Credential-free Claude Messages fixture",
    // Partial on purpose: the Claude path reads only these fields (unchanged fixture values).
    properties: { contextWindow: 32_768 } as Model["properties"],
    optionSpecs: { maxOutputTokens: { max: 32_768 } } as Model["optionSpecs"],
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
            request.abortSignal?.addEventListener("abort", () => resolve(), { once: true }),
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

      // Only count tool results after the latest user turn. Session history keeps
      // earlier allow/deny tool rows, so a global priorToolResults.length===0 check
      // makes DENY_/RUN_TWO_/… fall through to plain text and hang the Host waiter.
      const lastUserIndex = request.messages.map((m) => m.role).lastIndexOf("user");
      const toolsAfterLastUser = request.messages
        .slice(Math.max(0, lastUserIndex + 1))
        .filter((message) => message.role === "tool");
      const priorToolResults = request.messages.filter((message) => message.role === "tool");
      if (userText.includes("ALLOW_FIXED_WRITE") && toolsAfterLastUser.length === 0) {
        yield toolCall("toolu-allow", writeInput(input.paths.allowedWrite, "allowed"));
        yield finish("tool-calls", request.messages.length);
        return;
      }
      if (userText.includes("DENY_FIXED_WRITE") && toolsAfterLastUser.length === 0) {
        yield toolCall("toolu-deny", writeInput(input.paths.deniedWrite, "denied"));
        yield finish("tool-calls", request.messages.length);
        return;
      }
      if (userText.includes("RUN_TWO_TOOLS") && toolsAfterLastUser.length === 0) {
        yield toolCall("toolu-multi-a", writeInput(input.paths.multiWriteA, "alpha"));
        yield toolCall("toolu-multi-b", writeInput(input.paths.multiWriteB, "beta"));
        yield finish("tool-calls", request.messages.length);
        return;
      }
      if (userText.includes("DUPLICATE_NATIVE_TOOL_ID") && toolsAfterLastUser.length === 0) {
        yield toolCall("toolu-duplicate", writeInput(input.paths.deniedWrite, "duplicate"));
        yield toolCall("toolu-duplicate", writeInput(input.paths.deniedWrite, "duplicate"));
        yield finish("tool-calls", request.messages.length);
        return;
      }
      if (userText.includes("CHECK_TOOL_ENV") && toolsAfterLastUser.length === 0) {
        yield toolCall("toolu-env", {
          command:
            "if env | grep -E '^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|CLAUDE_CONFIG_DIR|ZCODE_CODEX_GATEWAY_TOKEN)=' >/dev/null; then printf leaked; else printf clean; fi",
        });
        yield finish("tool-calls", request.messages.length);
        return;
      }
      const text = toolsAfterLastUser.some((message) => message.isError)
        ? "tool denied safely"
        : toolsAfterLastUser.length
          ? "tool roundtrip complete"
          : `fake-${input.routeId}:${userText}`;
      yield { type: "text_start", id: `text-${trace.length}` };
      yield { type: "text_delta", id: `text-${trace.length}`, text };
      yield { type: "text_end", id: `text-${trace.length}` };
      yield finish("stop", request.messages.length);
    },
  };
  return {
    model,
    trace,
    get abortCount() {
      return abortCount;
    },
  };
}

function writeInput(path: string, value: string): Record<string, unknown> {
  // Only `command` is correlated against PreToolUse; Claude may add description/timeout/etc.
  // Prefer a workspace-relative basename so Claude's default sandbox can write under cwd.
  const base = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
  return {
    command: `printf '%s' '${value}' >> '${base}'`,
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
  if (typeof content === "string") return stripClaudeSystemReminders(content);
  return stripClaudeSystemReminders(
    content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
}

/** Claude Code 2.1.263 prepends sandbox/date <system-reminder> blocks onto the user turn text. */
function stripClaudeSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
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
