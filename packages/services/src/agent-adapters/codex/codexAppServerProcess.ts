import { spawn, type ChildProcess } from "node:child_process";
import {
  shouldSpawnInDetachedProcessGroup,
  terminateProcessTreeAndWait,
} from "#src/process/processTreeTerminator.js";

export type JsonRpcId = string | number;
export interface CodexJsonRpcMessage {
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

export interface CodexAppServerProcessOptions {
  readonly executablePath: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onNotification: (method: string, params: unknown) => void;
  readonly onServerRequest: (message: CodexJsonRpcMessage) => Promise<void>;
  readonly onFailure: (error: Error) => void;
  readonly onStderr?: (chunk: string) => void;
}

/** JSON-RPC control plane. Production spawns app-server; tests inject a fake transport. */
export interface CodexAppServerTransport {
  request(method: string, params: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params: unknown): Promise<void>;
  respondToServerRequest(id: JsonRpcId, result: unknown): Promise<void>;
  rejectServerRequest(id: JsonRpcId, code: number, message: string): Promise<void>;
  terminate(): Promise<void>;
}

export type CodexAppServerLauncher = (
  options: CodexAppServerProcessOptions,
) => Promise<CodexAppServerTransport>;

interface PendingRequest {
  readonly method: string;
  readonly timer: ReturnType<typeof setTimeout>;
  resolve(value: unknown): void;
  reject(error: Error): void;
}

const MAX_PROTOCOL_LINE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const STDIO_WRITE_TIMEOUT_MS = 30_000;

export class CodexAppServerProcess implements CodexAppServerTransport {
  readonly child: ChildProcess;
  readonly closed: Promise<void>;
  readonly #pending = new Map<string, PendingRequest>();
  readonly #options: CodexAppServerProcessOptions;
  readonly #closedResolve: () => void;
  #lineBuffer = "";
  #nextRequestId = 0;
  #closing = false;
  #failed = false;

  private constructor(options: CodexAppServerProcessOptions, child: ChildProcess) {
    this.#options = options;
    this.child = child;
    let resolve!: () => void;
    this.closed = new Promise<void>((done) => {
      resolve = done;
    });
    this.#closedResolve = resolve;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.#read(chunk));
    child.stdout?.on("end", () => this.#finishLineBuffer());
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.#options.onStderr?.(String(chunk).slice(0, 4096));
    });
    child.on("error", () => this.#fail(new Error("Codex app-server process could not be started")));
    child.on("close", (code, signal) => this.#onClose(code, signal));
  }

  static async launch(options: CodexAppServerProcessOptions): Promise<CodexAppServerProcess> {
    const child = spawn(
      options.executablePath,
      [
        "app-server",
        "--stdio",
        "--strict-config",
        "--disable",
        "multi_agent",
        "--disable",
        "apps",
        "--disable",
        "remote_plugin",
        "--disable",
        "plugins",
      ],
      {
        cwd: options.cwd,
        env: options.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: shouldSpawnInDetachedProcessGroup(),
        // 修复依据：0.157.1 用 0777 创建 sandbox/arg0 私有目录并依赖进程 umask；仅隔离 TMPDIR 仍会得到 0775，触发 socket 目录校验失败。
        ...(process.platform === "win32" ? {} : { umask: 0o077 }),
        windowsHide: true,
      },
    );
    const connection = new CodexAppServerProcess(options, child);
    await new Promise<void>((resolve, reject) => {
      const started = () => {
        cleanup();
        resolve();
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      const cleanup = () => {
        child.off("spawn", started);
        child.off("error", failed);
      };
      child.once("spawn", started);
      child.once("error", failed);
    });
    return connection;
  }

  request(method: string, params: unknown, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): Promise<unknown> {
    if (this.#closing || this.#failed)
      return Promise.reject(new Error("Codex app-server is unavailable"));
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1)
      return Promise.reject(new Error("Codex RPC timeout must be a positive integer"));
    const id = `zcode-${++this.#nextRequestId}`;
    const key = idKey(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#fail(new Error(`Codex app-server ${method} timed out; execution outcome is unknown`));
      }, timeoutMs);
      this.#pending.set(key, { method, timer, resolve, reject });
      void this.#write({ id, method, params }).catch((error: unknown) => {
        const pending = this.#pending.get(key);
        if (pending) clearTimeout(pending.timer);
        this.#pending.delete(key);
        reject(error instanceof Error ? error : new Error("Codex app-server write failed"));
      });
    });
  }

  notify(method: string, params: unknown): Promise<void> {
    if (this.#closing || this.#failed)
      return Promise.reject(new Error("Codex app-server is unavailable"));
    return this.#write({ method, params });
  }

  respondToServerRequest(id: JsonRpcId, result: unknown): Promise<void> {
    if (this.#closing || this.#failed)
      return Promise.reject(new Error("Codex app-server is unavailable"));
    return this.#write({ id, result });
  }

  rejectServerRequest(id: JsonRpcId, code: number, message: string): Promise<void> {
    if (this.#closing || this.#failed)
      return Promise.reject(new Error("Codex app-server is unavailable"));
    return this.#write({ id, error: { code, message } });
  }

  async terminate(): Promise<void> {
    if (this.#closing) return this.closed;
    this.#closing = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      const termination =
        this.child.pid === undefined ? {} : { ownedProcessGroupId: this.child.pid };
      await terminateProcessTreeAndWait(this.child, termination);
    }
    await this.closed;
  }

  #read(chunk: string): void {
    this.#lineBuffer += chunk;
    if (
      Buffer.byteLength(this.#lineBuffer, "utf8") > MAX_PROTOCOL_LINE_BYTES &&
      !this.#lineBuffer.includes("\n")
    ) {
      this.#fail(new Error("Codex app-server protocol line exceeded its size limit"));
      return;
    }
    for (;;) {
      const newline = this.#lineBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.#lineBuffer.slice(0, newline).trim();
      this.#lineBuffer = this.#lineBuffer.slice(newline + 1);
      if (!line) continue;
      if (Buffer.byteLength(line, "utf8") > MAX_PROTOCOL_LINE_BYTES) {
        this.#fail(new Error("Codex app-server protocol line exceeded its size limit"));
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#fail(new Error("Codex app-server emitted malformed JSON-RPC"));
        return;
      }
      this.#dispatchMessage(message);
      if (this.#failed) return;
    }
  }

  #dispatchMessage(value: unknown): void {
    if (!isRecord(value)) {
      this.#fail(new Error("Codex app-server emitted a malformed JSON-RPC message"));
      return;
    }
    const message = value as CodexJsonRpcMessage;
    if (typeof message.method === "string") {
      if (message.id !== undefined && isJsonRpcId(message.id)) {
        void this.#options.onServerRequest(message).catch(() => {
          this.#fail(new Error("Codex app-server request could not be handled"));
        });
      } else if (message.id === undefined) {
        this.#options.onNotification(message.method, message.params);
      } else {
        this.#fail(new Error("Codex app-server request has an invalid JSON-RPC id"));
      }
      return;
    }
    if (message.id === undefined || !isJsonRpcId(message.id)) {
      this.#fail(new Error("Codex app-server emitted an uncorrelated JSON-RPC response"));
      return;
    }
    const key = idKey(message.id);
    const pending = this.#pending.get(key);
    if (!pending) {
      this.#fail(new Error("Codex app-server emitted an unknown JSON-RPC response id"));
      return;
    }
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      const error = isRecord(message.error) ? message.error : {};
      const code =
        typeof error.code === "string" || typeof error.code === "number"
          ? String(error.code)
          : "unknown";
      const rawDetail = typeof error.message === "string" ? error.message.slice(0, 512) : "";
      const gatewayToken = this.#options.env.ZCODE_CODEX_GATEWAY_TOKEN;
      const detail = gatewayToken ? rawDetail.replaceAll(gatewayToken, "<redacted>") : rawDetail;
      pending.reject(
        new Error(
          `Codex app-server rejected ${pending.method} (${code})${detail ? `: ${detail}` : ""}`,
        ),
      );
    } else {
      pending.resolve(message.result);
    }
  }

  #finishLineBuffer(): void {
    if (this.#lineBuffer.trim())
      this.#fail(new Error("Codex app-server closed with a partial JSON-RPC line"));
    this.#lineBuffer = "";
  }

  #onClose(code: number | null, signal: NodeJS.Signals | null): void {
    this.#closedResolve();
    if (!this.#closing && !this.#failed) {
      this.#fail(new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`));
    } else {
      this.#rejectPending(new Error("Codex app-server closed"));
    }
  }

  #fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#rejectPending(error);
    this.#options.onFailure(error);
    if (!this.#closing && this.child.exitCode === null && this.child.signalCode === null) {
      const termination =
        this.child.pid === undefined ? {} : { ownedProcessGroupId: this.child.pid };
      void terminateProcessTreeAndWait(this.child, termination);
    }
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  #write(message: Record<string, unknown>): Promise<void> {
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable)
      return Promise.reject(new Error("Codex app-server stdin is closed"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(
          "Codex app-server stdio write timed out; session outcome is unknown",
        );
        this.#fail(error);
        reject(error);
      }, STDIO_WRITE_TIMEOUT_MS);
      stdin.write(JSON.stringify(message) + "\n", (error) => {
        clearTimeout(timer);
        if (error) reject(new Error("Codex app-server write failed"));
        else resolve();
      });
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function idKey(value: JsonRpcId): string {
  return `${typeof value}:${String(value)}`;
}
