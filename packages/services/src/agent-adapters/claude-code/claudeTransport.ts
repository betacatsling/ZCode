import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  HookJSONOutput,
  Query,
  SDKMessage,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";

const VERSION = "2.1.263";
const MAX_EVENT_BYTES = 256 * 1024;
const MAX_EVENTS = 10000;
const MAX_PENDING = 16;

export type ClaudeTransportEvent =
  | { type: "session"; nativeSessionId: string; version: string }
  | { type: "text"; text: string }
  | { type: "tool"; id: string; name: string; input: unknown }
  | { type: "toolResult"; id: string; error: boolean; text?: string }
  | { type: "permission"; id: string; nativeToolId: string; name: string; input: unknown }
  | { type: "result"; nativeSessionId: string; usage: unknown };

export interface ClaudeTransportOptions {
  cwd: string;
  profileDir: string;
  gatewayUrl: string;
  gatewayToken: string;
  model: string;
  resumeId?: string;
  sessionId?: string;
  queryFactory?: typeof query;
  spawn?: (options: SpawnOptions) => SpawnedProcess;
}

type Pending = {
  nativeToolId: string;
  resolve: (decision: "allow" | "deny") => void;
  cancel: () => void;
};

/** Owns exactly one turn and its tool decisions, never a host session or model credential store. */
export class ClaudeCodeTransport {
  private readonly options: ClaudeTransportOptions;
  private readonly pending = new Map<string, Pending>();
  private active = false;
  private controller?: AbortController;
  private currentQuery?: Query;
  private nativeSessionId?: string;

  constructor(options: ClaudeTransportOptions) {
    let url: URL;
    try {
      url = new URL(options.gatewayUrl);
    } catch {
      throw new Error("invalid_gateway_origin");
    }
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.port ||
      url.pathname !== "/"
    )
      throw new Error("invalid_gateway_origin");
    if (
      !options.gatewayToken ||
      !options.profileDir ||
      !options.cwd ||
      !options.model ||
      !isAbsolute(options.cwd) ||
      !isAbsolute(options.profileDir) ||
      !relative(resolve(options.cwd), resolve(options.profileDir)).startsWith("..") ||
      resolve(options.profileDir) === resolve(process.env.HOME ?? "")
    )
      throw new Error("invalid_claude_transport_options");
    if (
      (options.resumeId && options.sessionId) ||
      [options.resumeId, options.sessionId].some(
        (id) => id && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id),
      )
    )
      throw new Error("invalid_claude_session_id");
    this.options = options;
  }

  reply(id: string, decision: "allow" | "deny"): boolean {
    const pending = this.pending.get(id);
    if (!this.active || !pending || (decision !== "allow" && decision !== "deny")) return false;
    this.pending.delete(id);
    pending.resolve(decision);
    return true;
  }

  cancel(): void {
    this.controller?.abort();
    this.currentQuery?.close();
    this.clearPending();
  }

  unsupported(action: "detach" | "fork" | "changePermissionMode" | "resumeExecution"): {
    status: "unsupported";
    action: string;
  } {
    return { status: "unsupported", action };
  }

  async run(
    prompt: string,
    onEvent: (event: ClaudeTransportEvent) => void,
  ): Promise<{ nativeSessionId: string }> {
    if (this.active) throw new Error("claude_turn_already_running");
    if (!prompt.trim()) throw new Error("empty_claude_prompt");
    this.active = true;
    this.controller = new AbortController();
    this.nativeSessionId = undefined;
    let exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let successfulResult: Extract<SDKMessage, { type: "result" }> | undefined;
    let events = 0;
    const spawnProcess = (options: SpawnOptions): SpawnedProcess => {
      const local = this.options.spawn
        ? undefined
        : spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
          });
      // stderr is diagnostic-only: drain it without returning token-bearing lines to callers.
      local?.stderr.resume();
      const child: SpawnedProcess = local ?? this.options.spawn!(options);
      exit = new Promise((resolve, reject) => {
        child.once("exit", (code, signal) => resolve({ code, signal }));
        child.once("error", reject);
      });
      return child;
    };
    const deny = (): HookJSONOutput => ({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Host denied tool execution",
      },
    });
    try {
      const sdk = this.options.queryFactory ?? query;
      const stream = sdk({
        prompt,
        options: {
          cwd: this.options.cwd,
          model: this.options.model,
          resume: this.options.resumeId,
          sessionId: this.options.sessionId,
          thinking: { type: "disabled" },
          abortController: this.controller,
          settingSources: [],
          strictMcpConfig: true,
          tools: ["Read", "Edit", "Write", "Bash"],
          permissionMode: "default",
          permissionPrompts: "host",
          includePartialMessages: true,
          env: {
            PATH: process.env.PATH ?? "",
            HOME: this.options.profileDir,
            CLAUDE_CONFIG_DIR: this.options.profileDir,
            ANTHROPIC_BASE_URL: this.options.gatewayUrl,
            ANTHROPIC_API_KEY: this.options.gatewayToken,
            CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
            CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
            ENABLE_CLAUDEAI_MCP_SERVERS: "false",
            LANG: "C.UTF-8",
          },
          spawnClaudeCodeProcess: spawnProcess,
          canUseTool: async () => ({
            behavior: "deny",
            message: "Tool approval requires PreToolUse gate",
          }),
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (input, _id, { signal }) => {
                    if (
                      input.hook_event_name !== "PreToolUse" ||
                      !this.active ||
                      signal.aborted ||
                      this.controller?.signal.aborted ||
                      !this.nativeSessionId ||
                      input.session_id !== this.nativeSessionId ||
                      !input.tool_use_id ||
                      Buffer.byteLength(JSON.stringify(input.tool_input)) > MAX_EVENT_BYTES ||
                      this.pending.size >= MAX_PENDING ||
                      [...this.pending.values()].some(
                        (pending) => pending.nativeToolId === input.tool_use_id,
                      )
                    )
                      return deny();
                    const requestId = randomUUID();
                    const decision = await new Promise<"allow" | "deny">((resolve) => {
                      const cancel = () => {
                        this.pending.delete(requestId);
                        resolve("deny");
                      };
                      this.pending.set(requestId, {
                        nativeToolId: input.tool_use_id,
                        resolve,
                        cancel,
                      });
                      signal.addEventListener("abort", cancel, { once: true });
                      this.controller!.signal.addEventListener("abort", cancel, { once: true });
                      try {
                        onEvent({
                          type: "permission",
                          id: requestId,
                          nativeToolId: input.tool_use_id,
                          name: input.tool_name,
                          input: input.tool_input,
                        });
                      } catch {
                        cancel();
                      }
                    });
                    return decision === "allow" &&
                      this.active &&
                      !signal.aborted &&
                      !this.controller?.signal.aborted
                      ? {
                          hookSpecificOutput: {
                            hookEventName: "PreToolUse",
                            permissionDecision: "allow",
                          },
                        }
                      : deny();
                  },
                ],
              },
            ],
          },
        },
      });
      this.currentQuery = stream;
      for await (const message of stream) {
        if (this.controller.signal.aborted) throw new Error("claude_cancelled");
        if (++events > MAX_EVENTS || Buffer.byteLength(JSON.stringify(message)) > MAX_EVENT_BYTES)
          throw new Error("claude_frame_limit");
        if (message.type === "result") {
          if (message.subtype !== "success" || message.is_error)
            throw new Error("claude_result_error");
          successfulResult = message;
        } else this.accept(message, onEvent);
      }
      if (!exit) throw new Error("claude_process_not_started");
      const status = await exit;
      if (this.controller.signal.aborted) throw new Error("claude_cancelled");
      if (status.code !== 0 || status.signal) throw new Error("claude_process_exit_nonzero");
      if (
        !successfulResult ||
        !this.nativeSessionId ||
        successfulResult.session_id !== this.nativeSessionId
      )
        throw new Error("claude_result_missing");
      onEvent({
        type: "result",
        nativeSessionId: this.nativeSessionId,
        usage: successfulResult.modelUsage,
      });
      return { nativeSessionId: this.nativeSessionId };
    } catch (error) {
      this.controller.abort();
      const code = error instanceof Error ? error.message : "";
      const safeCodes = new Set([
        "claude_cancelled",
        "claude_frame_limit",
        "claude_process_not_started",
        "claude_process_exit_nonzero",
        "claude_result_missing",
        "claude_result_error",
        "claude_version_or_resume_mismatch",
      ]);
      throw new Error(safeCodes.has(code) ? code : "claude_sdk_failure");
    } finally {
      this.active = false;
      this.clearPending();
      this.currentQuery?.close();
      this.currentQuery = undefined;
      this.controller = undefined;
    }
  }

  private clearPending(): void {
    for (const request of this.pending.values()) request.cancel();
    this.pending.clear();
  }

  private accept(message: SDKMessage, onEvent: (event: ClaudeTransportEvent) => void): void {
    if (message.type === "system" && message.subtype === "init") {
      if (
        message.claude_code_version !== VERSION ||
        (this.options.resumeId && message.session_id !== this.options.resumeId) ||
        (this.options.sessionId && message.session_id !== this.options.sessionId) ||
        (this.nativeSessionId && message.session_id !== this.nativeSessionId)
      )
        throw new Error("claude_version_or_resume_mismatch");
      this.nativeSessionId = message.session_id;
      onEvent({ type: "session", nativeSessionId: message.session_id, version: VERSION });
    } else if (
      message.type === "stream_event" &&
      message.event.type === "content_block_delta" &&
      message.event.delta.type === "text_delta"
    ) {
      onEvent({ type: "text", text: message.event.delta.text });
    } else if (message.type === "assistant") {
      for (const block of message.message.content)
        if (block.type === "tool_use")
          onEvent({ type: "tool", id: block.id, name: block.name, input: block.input });
    } else if (
      message.type === "user" &&
      !message.isSynthetic &&
      Array.isArray(message.message.content)
    ) {
      for (const block of message.message.content)
        if (block.type === "tool_result") {
          const content = block.content;
          const text =
            typeof content === "string"
              ? content
              : Array.isArray(content)
                ? content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                : undefined;
          onEvent({
            type: "toolResult",
            id: block.tool_use_id,
            error: block.is_error === true,
            text: text?.slice(0, MAX_EVENT_BYTES / 2),
          });
        }
    }
  }
}
