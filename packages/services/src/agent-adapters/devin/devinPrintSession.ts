import { spawn, type ChildProcess } from "node:child_process";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";

/** One Wave 2 print-mode turn: `devin -p --respect-workspace-trust false -- <prompt>`. */
export class DevinPrintSession {
  readonly child: ChildProcess;
  readonly closed: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
  }>;
  #closing = false;
  #stdout = "";
  #stderr = "";
  #resolveClosed!: (result: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
  }) => void;
  #closeResult?: {
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stdout: string;
    readonly stderr: string;
  };

  constructor(input: {
    readonly executablePath: string;
    readonly cwd: string;
    readonly prompt: string;
    readonly env?: NodeJS.ProcessEnv;
    readonly onStdoutChunk?: (chunk: string) => void;
  }) {
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve;
    });
    const args = ["-p", "--respect-workspace-trust", "false", "--", input.prompt];
    this.child = spawn(input.executablePath, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: shouldSpawnInDetachedProcessGroup(),
    });
    this.child.stdout?.setEncoding("utf8");
    this.child.stderr?.setEncoding("utf8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.#stdout += chunk;
      input.onStdoutChunk?.(chunk);
    });
    this.child.stderr?.on("data", (chunk: string) => {
      this.#stderr += chunk;
    });
    this.child.once("error", (error) => {
      this.#closeResult = {
        code: null,
        signal: null,
        stdout: this.#stdout,
        stderr: `${this.#stderr}${error.message}`,
      };
      this.#resolveClosed(this.#closeResult);
    });
    this.child.once("close", (code, signal) => {
      this.#closeResult = {
        code,
        signal,
        stdout: this.#stdout,
        stderr: this.#stderr,
      };
      this.#resolveClosed(this.#closeResult);
    });
  }

  get isRunning(): boolean {
    return this.#closeResult === undefined;
  }

  async cancel(): Promise<void> {
    if (this.#closing) {
      await this.closed;
      return;
    }
    this.#closing = true;
    if (this.isRunning) {
      await terminateProcessTreeAndWait(this.child, { forceAfterMs: 2_000 });
    }
    await this.closed;
  }
}

export function createDevinPrintEnvironment(executablePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT", "USERPROFILE", "TEMP", "TMP"] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
  } else {
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (process.env.XDG_RUNTIME_DIR) env.XDG_RUNTIME_DIR = process.env.XDG_RUNTIME_DIR;
  }
  // Keep auth from the user environment when present; do not invent tokens.
  if (process.env.WINDSURF_API_KEY) env.WINDSURF_API_KEY = process.env.WINDSURF_API_KEY;
  if (process.env.DEVIN_API_KEY) env.DEVIN_API_KEY = process.env.DEVIN_API_KEY;
  void executablePath;
  return env;
}
