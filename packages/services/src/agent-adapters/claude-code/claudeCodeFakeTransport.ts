import type { ClaudeCodeNativeEvent } from "./claudeCodeNative.js";
import { assertIsolatedClaudeCodePath } from "./claudeCodeProfile.js";

export interface ClaudeCodeOpenedSession {
  readonly nativeSessionId: string;
  readonly acpSessionOpen: boolean;
}

export interface ClaudeCodePromptInput {
  readonly hostSessionId: string;
  readonly nativeSessionId: string;
  readonly turnId: string;
  readonly text: string;
}

export interface ClaudeCodeTransport {
  readonly kind: "fake" | "acp";
  open(input: {
    readonly hostSessionId: string;
    readonly workspaceKey: string;
    readonly configDir: string;
  }): Promise<ClaudeCodeOpenedSession>;
  prompt(input: ClaudeCodePromptInput): AsyncIterable<ClaudeCodeNativeEvent>;
  cancel(input: {
    readonly hostSessionId: string;
    readonly nativeSessionId: string;
    readonly turnId: string;
  }): Promise<void>;
  close(input: { readonly hostSessionId: string; readonly nativeSessionId: string }): Promise<void>;
  shutdown(): Promise<void>;
}

export interface FakeClaudeCodeScriptInput {
  readonly hostSessionId: string;
  readonly turnId: string;
  readonly text: string;
}

function defaultScript(input: FakeClaudeCodeScriptInput): readonly ClaudeCodeNativeEvent[] {
  const messageId = `${input.turnId}-message`;
  return [
    {
      kind: "text.delta",
      sourceEventId: `${input.turnId}-delta`,
      turnId: input.turnId,
      messageId,
      text: "ok",
    },
    {
      kind: "message.finished",
      sourceEventId: `${input.turnId}-finished`,
      turnId: input.turnId,
      messageId,
      text: "ok",
    },
    {
      kind: "usage.reported",
      sourceEventId: `${input.turnId}-usage`,
      turnId: input.turnId,
      inputTokens: 1,
      outputTokens: 1,
    },
    {
      kind: "turn.finished",
      sourceEventId: `${input.turnId}-turn`,
      turnId: input.turnId,
      outcome: "success",
    },
  ];
}

/** In-process transport used when no Claude credential is available. */
export class FakeClaudeCodeTransport implements ClaudeCodeTransport {
  readonly kind = "fake" as const;
  readonly openedConfigDirs: string[] = [];
  promptCount = 0;
  #refs = new Set<string>();
  #cancelled = new Set<string>();
  #shutDown = false;
  readonly #userHome: string;
  readonly #script: (input: FakeClaudeCodeScriptInput) => readonly ClaudeCodeNativeEvent[];
  readonly #delayMs: number;

  constructor(options: {
    readonly userHome: string;
    readonly script?: (input: FakeClaudeCodeScriptInput) => readonly ClaudeCodeNativeEvent[];
    readonly delayMs?: number;
  }) {
    this.#userHome = options.userHome;
    this.#script = options.script ?? defaultScript;
    this.#delayMs = options.delayMs ?? 0;
  }

  get refCount(): number {
    return this.#refs.size;
  }

  get shutDown(): boolean {
    return this.#shutDown;
  }

  async open(input: {
    readonly hostSessionId: string;
    readonly workspaceKey: string;
    readonly configDir: string;
  }): Promise<ClaudeCodeOpenedSession> {
    if (this.#shutDown) throw new Error("Claude Code fake transport is shut down");
    assertIsolatedClaudeCodePath(input.configDir, this.#userHome);
    this.#refs.add(input.hostSessionId);
    this.openedConfigDirs.push(input.configDir);
    return { nativeSessionId: `fake-${input.hostSessionId}`, acpSessionOpen: false };
  }

  async *prompt(input: ClaudeCodePromptInput): AsyncIterable<ClaudeCodeNativeEvent> {
    this.promptCount += 1;
    for (const event of this.#script(input)) {
      if (this.#delayMs > 0) await delay(this.#delayMs);
      if (this.#cancelled.has(cancelKey(input.hostSessionId, input.turnId))) return;
      yield event;
    }
  }

  async cancel(input: {
    readonly hostSessionId: string;
    readonly nativeSessionId: string;
    readonly turnId: string;
  }): Promise<void> {
    this.#cancelled.add(cancelKey(input.hostSessionId, input.turnId));
  }

  async close(input: { readonly hostSessionId: string }): Promise<void> {
    this.#refs.delete(input.hostSessionId);
  }

  async shutdown(): Promise<void> {
    if (this.#refs.size > 0) {
      throw new Error("Refusing to shut down the shared Claude Code transport while sessions remain");
    }
    this.#shutDown = true;
  }
}

/** Marks the same fake byte stream as ACP. That flag is not model acceptance. */
export class AcpMarkingTransport implements ClaudeCodeTransport {
  readonly kind = "acp" as const;

  constructor(private readonly inner: FakeClaudeCodeTransport) {}

  get refCount(): number {
    return this.inner.refCount;
  }

  get promptCount(): number {
    return this.inner.promptCount;
  }

  get shutDown(): boolean {
    return this.inner.shutDown;
  }

  async open(input: {
    readonly hostSessionId: string;
    readonly workspaceKey: string;
    readonly configDir: string;
  }): Promise<ClaudeCodeOpenedSession> {
    const opened = await this.inner.open(input);
    return { nativeSessionId: `acp-${opened.nativeSessionId}`, acpSessionOpen: true };
  }

  prompt(input: ClaudeCodePromptInput): AsyncIterable<ClaudeCodeNativeEvent> {
    return this.inner.prompt(input);
  }

  cancel(input: {
    readonly hostSessionId: string;
    readonly nativeSessionId: string;
    readonly turnId: string;
  }): Promise<void> {
    return this.inner.cancel(input);
  }

  close(input: { readonly hostSessionId: string; readonly nativeSessionId: string }): Promise<void> {
    return this.inner.close(input);
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

function cancelKey(hostSessionId: string, turnId: string): string {
  return `${hostSessionId}\0${turnId}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
