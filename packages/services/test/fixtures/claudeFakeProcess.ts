import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ClaudeStreamProcess,
  ClaudeStructuredMessage,
} from "../../src/agent-adapters/claude/claudeStreamProcess.js";

// Injected stand-in for ClaudeStreamProcess used through the adapter's launchProcess hook.
// It never spawns; loopback HTTP helpers reach the real hook server and Model Gateway.

export type FakeClaudeLaunchOptions = ConstructorParameters<typeof ClaudeStreamProcess>[0];

export interface FakeClaudeProcessBehavior {
  /** Runs inside launchProcess before it resolves; throwing rejects the launch. */
  readonly onLaunch?: (process: FakeClaudeProcess) => void | Promise<void>;
  /** Runs after a structured user message is accepted. */
  readonly onSend?: (process: FakeClaudeProcess, text: string) => void | Promise<void>;
  /** Runs when the adapter aborts the process (cancel), before it is marked stopped. */
  readonly onAbort?: (process: FakeClaudeProcess) => void;
}

let nextPid = 71_000;

export class FakeClaudeProcess {
  readonly pid = nextPid++;
  readonly sent: string[] = [];
  readonly calls: string[] = [];
  isRunning = true;
  #token?: string;

  constructor(
    readonly options: FakeClaudeLaunchOptions,
    private readonly behavior: FakeClaudeProcessBehavior,
  ) {}

  get nativeSessionId(): string {
    const args = this.options.args;
    const flag = args.includes("--resume") ? "--resume" : "--session-id";
    return args[args.indexOf(flag) + 1]!;
  }

  get resumed(): boolean {
    return this.options.args.includes("--resume");
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.isRunning) throw new Error("Claude Code process is not accepting structured input");
    this.sent.push(text);
    await this.behavior.onSend?.(this, text);
  }

  async terminate(): Promise<void> {
    this.calls.push("terminate");
    this.isRunning = false;
  }

  async abort(): Promise<void> {
    this.calls.push("abort");
    this.behavior.onAbort?.(this);
    this.isRunning = false;
  }

  emit(message: ClaudeStructuredMessage): void {
    this.options.onMessage(message);
  }

  init(): void {
    this.emit({ type: "system", subtype: "init", session_id: this.nativeSessionId });
  }

  result(fields: Record<string, unknown> = {}): void {
    this.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: this.nativeSessionId,
      usage: { input_tokens: 3, output_tokens: 2 },
      ...fields,
    });
  }

  fail(error: Error): void {
    this.options.onFailure(error);
  }

  /** Simulates an exit the adapter has not observed through onFailure. */
  exit(): void {
    this.isRunning = false;
  }

  async hookUrl(): Promise<string> {
    const args = this.options.args;
    const settingsPath = args[args.indexOf("--settings") + 1]!;
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as {
      hooks: { PreToolUse: { hooks: { url: string }[] }[] };
    };
    return settings.hooks.PreToolUse[0]!.hooks[0]!.url;
  }

  /** POSTs a PreToolUse callback like Claude Code's http hook; returns the decision or "unreachable". */
  async preToolUse(toolUseId: string, toolName: string, toolInput: unknown): Promise<string> {
    const url = await this.hookUrl();
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          hook_event_name: "PreToolUse",
          session_id: this.nativeSessionId,
          tool_name: toolName,
          tool_use_id: toolUseId,
          tool_input: toolInput,
        }),
      });
      const body = (await response.json()) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      return body.hookSpecificOutput.permissionDecision;
    } catch {
      return "unreachable";
    }
  }

  /** Reads the helper token this launch was given (a rebind rewrites the shared profile file). */
  async captureToken(): Promise<string> {
    const path = join(this.options.env.CLAUDE_CONFIG_DIR!, "gateway-session-capability");
    this.#token = (await readFile(path, "utf8")).trim();
    return this.#token;
  }

  /** Calls the Gateway Messages route with the helper token: 400 (empty body) while granted, 401 once revoked. */
  async gatewayStatus(): Promise<number | "unreachable"> {
    const env = this.options.env;
    const token = this.#token ?? (await this.captureToken());
    try {
      const response = await fetch(`${env.ANTHROPIC_BASE_URL}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "claude-code-20250219",
          "anthropic-dangerous-direct-browser-access": "true",
          "x-api-key": token,
        },
        body: "{}",
      });
      await response.arrayBuffer();
      return response.status;
    } catch {
      return "unreachable";
    }
  }
}

export function fakeClaudeLauncher(behavior: FakeClaudeProcessBehavior = {}) {
  const launches: FakeClaudeProcess[] = [];
  const launchProcess = async (options: FakeClaudeLaunchOptions): Promise<ClaudeStreamProcess> => {
    const process = new FakeClaudeProcess(options, behavior);
    launches.push(process);
    await process.captureToken();
    await behavior.onLaunch?.(process);
    return process as unknown as ClaudeStreamProcess;
  };
  return { launchProcess, launches };
}
