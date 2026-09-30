import { spawn, type ChildProcess } from "node:child_process";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";

const MAX_STREAM_LINE_BYTES = 8 * 1024 * 1024;

export interface ClaudeStructuredMessage {
  readonly type: string;
  readonly [key: string]: unknown;
}

export class ClaudeStreamProcess {
  readonly child: ChildProcess;
  readonly closed: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly #onMessage: (message: ClaudeStructuredMessage) => void;
  readonly #onFailure: (error: Error) => void;
  #lineBuffer = "";
  #closing = false;
  #closeResult?: { readonly code: number | null; readonly signal: NodeJS.Signals | null };
  #resolveClosed!: (result: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }) => void;

  constructor(input: {
    readonly executablePath: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly env: NodeJS.ProcessEnv;
    readonly onMessage: (message: ClaudeStructuredMessage) => void;
    readonly onFailure: (error: Error) => void;
  }) {
    this.#onMessage = input.onMessage;
    this.#onFailure = input.onFailure;
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    this.child = spawn(input.executablePath, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: shouldSpawnInDetachedProcessGroup(),
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.resume();
    this.child.stdout?.on("data", (chunk: string) => this.#read(chunk));
    this.child.stderr?.on("data", () => {
      // Stderr can contain prompts or provider diagnostics; drain it without logging it.
    });
    this.child.once("error", (error) => this.#fail(error));
    this.child.once("close", (code, signal) => {
      if (!this.#closing && this.#lineBuffer.trim())
        this.#onFailure(new Error("Claude Code ended with an incomplete structured stream line"));
      this.#closeResult = { code, signal };
      this.#resolveClosed(this.#closeResult);
      if (!this.#closing && code !== 0)
        this.#onFailure(new Error("Claude Code process exited without a terminal result"));
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  get isRunning(): boolean {
    return this.#closeResult === undefined;
  }

  async sendUserMessage(text: string): Promise<void> {
    if (!this.isRunning || !this.child.stdin || this.child.stdin.destroyed)
      throw new Error("Claude Code process is not accepting structured input");
    const line = `${JSON.stringify({
      type: "user",
      message: { role: "user", content: text },
    })}\n`;
    if (!this.child.stdin.write(line)) {
      await new Promise<void>((resolve, reject) => {
        this.child.stdin!.once("drain", resolve);
        this.child.stdin!.once("error", reject);
      });
    }
  }

  async terminate(): Promise<void> {
    if (this.#closing) {
      await this.closed;
      return;
    }
    this.#closing = true;
    if (this.isRunning) {
      this.child.stdin?.end();
      await Promise.race([this.closed, delay(5_000)]);
      if (this.isRunning) await this.#terminateOwnedTree();
    }
    await this.closed;
  }

  async abort(): Promise<void> {
    if (this.#closing) {
      await this.closed;
      return;
    }
    this.#closing = true;
    if (this.isRunning) await this.#terminateOwnedTree();
    await this.closed;
  }

  async #terminateOwnedTree(): Promise<void> {
    const termination = this.child.pid === undefined ? {} : { ownedProcessGroupId: this.child.pid };
    await terminateProcessTreeAndWait(this.child, termination);
  }

  #read(chunk: string): void {
    this.#lineBuffer += chunk;
    if (
      Buffer.byteLength(this.#lineBuffer, "utf8") > MAX_STREAM_LINE_BYTES &&
      !this.#lineBuffer.includes("\n")
    ) {
      this.#fail(new Error("Claude structured stream line exceeded its size limit"));
      return;
    }
    for (;;) {
      const newline = this.#lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#lineBuffer.slice(0, newline).trim();
      this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_STREAM_LINE_BYTES) {
        this.#fail(new Error("Claude structured stream line exceeded its size limit"));
        return;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        this.#fail(new Error("Claude Code emitted a non-JSON structured stream line"));
        return;
      }
      if (!isRecord(value) || typeof value.type !== "string") {
        this.#fail(new Error("Claude Code emitted an invalid structured stream message"));
        return;
      }
      try {
        this.#onMessage(value as ClaudeStructuredMessage);
      } catch {
        this.#fail(new Error("Claude structured stream event could not be translated"));
        return;
      }
    }
  }

  #fail(error: Error): void {
    if (this.#closing) return;
    this.#onFailure(error);
    void this.abort().catch(() => undefined);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
