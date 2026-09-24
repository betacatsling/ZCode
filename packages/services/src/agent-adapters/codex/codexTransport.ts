import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { launchCodex, type CodexLaunchOptions } from "./codexLaunch.js";

const MAX_FRAME = 1024 * 1024;
const MAX_QUEUE = 4 * MAX_FRAME;
const MAX_PENDING = 128;
const APPROVAL_METHODS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
]);
type RpcId = string | number;
type ObjectValue = Record<string, unknown>;
const record = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type CodexNativeEvent =
  | { kind: "notification"; method: string; params: unknown }
  | {
      kind: "approval";
      method: string;
      params: ObjectValue;
      callbackId: string;
      approvalId: string | null;
    };
export interface CodexTransportOptions extends CodexLaunchOptions {
  model: string;
  onEvent: (event: CodexNativeEvent) => void;
  onFailure?: () => void;
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Approval = { rpcId: RpcId; threadId: string; turnId: string; itemId: string; method: string };

export async function createCodexTransport(
  options: CodexTransportOptions,
): Promise<CodexTransport> {
  if (!options.model.trim()) throw new Error("Codex model is required");
  const child = await launchCodex(options);
  const transport = new CodexTransport(child, options.onEvent, options.model, options.onFailure);
  try {
    await transport.initialize();
    return transport;
  } catch (error) {
    await transport.close();
    throw error;
  }
}

export class CodexTransport {
  private nextId = 0;
  private nextApprovalId = 0;
  private readonly pending = new Map<RpcId, Pending>();
  private readonly approvals = new Map<string, Approval>();
  private readonly seenApprovalRpcIds = new Set<RpcId>();
  private readonly activeTurns = new Map<string, string>();
  private readonly interruptingTurns = new Set<string>();
  private readonly startingTurns = new Set<string>();
  private readonly earlyCompleted = new Map<string, string>();
  private readonly decoder = new StringDecoder("utf8");
  private input = "";
  private queue: string[] = [];
  private queuedBytes = 0;
  private writing = false;
  private stopped = false;
  private readonly onExit: () => void;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly onEvent: (event: CodexNativeEvent) => void,
    private readonly model: string,
    private readonly onFailure?: () => void,
  ) {
    child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
    child.stdout.on("end", () => {
      if (!this.stopped) this.fail(new Error("Codex stdout ended"));
    });
    child.stdout.on("error", () => this.fail(new Error("Codex stdout failed")));
    child.stdin.on("error", () => this.fail(new Error("Codex stdin failed")));
    // stderr can include prompts, paths and credentials; never forward it to application logs.
    child.stderr.resume();
    this.onExit = () => this.fail(new Error("Codex app-server exited"));
    child.once("exit", this.onExit);
    child.once("error", this.onExit);
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "zcode", title: "ZCode", version: "0.3" },
      capabilities: { experimentalApi: false, requestAttestation: false },
    });
    await this.send({ method: "initialized", params: {} });
  }

  async startThread(): Promise<string> {
    const value = await this.request("thread/start", {
      model: this.model,
      modelProvider: "zcode",
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    return this.threadId(value);
  }

  async resumeThread(threadId: string): Promise<string> {
    const value = await this.request("thread/resume", {
      threadId,
      model: this.model,
      modelProvider: "zcode",
      approvalPolicy: "on-request",
      sandbox: "read-only",
    });
    return this.threadId(value);
  }

  async startTurn(threadId: string, text: string): Promise<string> {
    if (!threadId || !text || this.activeTurns.has(threadId) || this.startingTurns.has(threadId))
      throw new Error("Codex turn is invalid or already active");
    this.startingTurns.add(threadId);
    try {
      const value = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text }],
        effort: "none",
        summary: "none",
      });
      if (!record(value) || !record(value.turn) || typeof value.turn.id !== "string")
        throw new Error("Invalid Codex turn response");
      if (this.earlyCompleted.get(threadId) !== value.turn.id)
        this.activeTurns.set(threadId, value.turn.id);
      return value.turn.id;
    } finally {
      this.startingTurns.delete(threadId);
      this.earlyCompleted.delete(threadId);
    }
  }

  async interruptTurn(threadId: string, turnId: string): Promise<void> {
    if (this.activeTurns.get(threadId) !== turnId) throw new Error("Stale Codex turn");
    // 修复原因：RPC ACK 不等于 turn/completed；保留活动标识直到原生终态，停止后续审批。
    this.interruptingTurns.add(turnId);
    this.denyTurn(threadId, turnId);
    await this.request("turn/interrupt", { threadId, turnId });
  }

  async replyApproval(callbackId: string, decision: "accept" | "decline"): Promise<void> {
    const approval = this.approvals.get(callbackId);
    if (!approval || this.activeTurns.get(approval.threadId) !== approval.turnId)
      throw new Error("Stale or unknown Codex approval");
    this.approvals.delete(callbackId);
    await this.send({ id: approval.rpcId, result: { decision } });
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) {
      this.fail(new Error("Codex transport closed"));
      return;
    }
    const exited = new Promise<void>((resolveExit) => this.child.once("exit", () => resolveExit()));
    this.fail(new Error("Codex transport closed"));
    const timer = setTimeout(() => this.child.kill("SIGKILL"), 2000);
    try {
      await exited;
    } finally {
      clearTimeout(timer);
    }
  }

  private threadId(value: unknown): string {
    if (!record(value) || !record(value.thread) || typeof value.thread.id !== "string")
      throw new Error("Invalid Codex thread response");
    if (value.modelProvider !== "zcode" || value.model !== this.model)
      throw new Error("Codex thread model binding mismatch");
    return value.thread.id;
  }

  private request(method: string, params: ObjectValue): Promise<unknown> {
    if (this.stopped) return Promise.reject(new Error("Codex transport closed"));
    if (this.pending.size >= MAX_PENDING)
      return Promise.reject(new Error("Codex request limit exceeded"));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Codex request timed out"));
        this.fail(new Error("Codex request timed out"));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      void this.send({ id, method, params }).catch((error: Error) => {
        const entry = this.pending.get(id);
        if (entry) {
          clearTimeout(entry.timer);
          this.pending.delete(id);
          entry.reject(error);
        }
      });
    });
  }

  private send(message: ObjectValue): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("Codex transport closed"));
    const line = `${JSON.stringify(message)}\n`;
    const size = Buffer.byteLength(line);
    if (size > MAX_FRAME || size + this.queuedBytes + this.child.stdin.writableLength > MAX_QUEUE) {
      this.fail(new Error("Codex output limit exceeded"));
      return Promise.reject(new Error("Codex output limit exceeded"));
    }
    this.queue.push(line);
    this.queuedBytes += size;
    this.flush();
    return Promise.resolve();
  }

  private flush(): void {
    if (this.writing || this.stopped) return;
    while (this.queue.length) {
      const line = this.queue.shift()!;
      this.queuedBytes -= Buffer.byteLength(line);
      if (!this.child.stdin.write(line)) {
        this.writing = true;
        this.child.stdin.once("drain", () => {
          this.writing = false;
          this.flush();
        });
        return;
      }
    }
  }

  private read(chunk: Buffer): void {
    if (this.stopped) return;
    this.input += this.decoder.write(chunk);
    if (Buffer.byteLength(this.input) > MAX_FRAME && !this.input.includes("\n")) {
      this.fail(new Error("Codex frame too large"));
      return;
    }
    for (;;) {
      const end = this.input.indexOf("\n");
      if (end < 0) break;
      const line = this.input.slice(0, end);
      this.input = this.input.slice(end + 1);
      if (Buffer.byteLength(line) > MAX_FRAME) {
        this.fail(new Error("Codex frame too large"));
        return;
      }
      try {
        this.receive(JSON.parse(line) as unknown);
      } catch {
        this.fail(new Error("Malformed Codex RPC frame"));
        return;
      }
      if (this.stopped) return;
    }
  }

  private receive(value: unknown): void {
    if (!record(value)) throw new Error("Invalid RPC message");
    const id = value.id;
    if (typeof value.method === "string") {
      if (id === undefined) {
        if (
          value.method === "turn/completed" &&
          record(value.params) &&
          record(value.params.turn) &&
          typeof value.params.threadId === "string" &&
          typeof value.params.turn.id === "string"
        ) {
          if (this.activeTurns.get(value.params.threadId) === value.params.turn.id) {
            this.activeTurns.delete(value.params.threadId);
            this.interruptingTurns.delete(value.params.turn.id);
            this.denyTurn(value.params.threadId, value.params.turn.id);
          } else if (this.startingTurns.has(value.params.threadId))
            this.earlyCompleted.set(value.params.threadId, value.params.turn.id);
        }
        this.onEvent({ kind: "notification", method: value.method, params: value.params });
      } else if (typeof id === "number" || typeof id === "string")
        this.approvalRequest(id, value.method, value.params);
      else throw new Error("Invalid RPC request ID");
      return;
    }
    if (typeof id !== "number" || !this.pending.has(id)) return;
    const pending = this.pending.get(id)!;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (value.error !== undefined) pending.reject(new Error("Codex RPC request failed"));
    else pending.resolve(value.result);
  }

  private approvalRequest(id: RpcId, method: string, params: unknown): void {
    if (
      !APPROVAL_METHODS.has(method) ||
      !record(params) ||
      typeof params.threadId !== "string" ||
      typeof params.turnId !== "string" ||
      typeof params.itemId !== "string"
    ) {
      void this.send({ id, error: { code: -32601, message: "Unsupported request" } });
      return;
    }
    if (this.seenApprovalRpcIds.has(id)) return;
    if (this.seenApprovalRpcIds.size >= 1024) {
      this.fail(new Error("Codex approval ID limit exceeded"));
      return;
    }
    this.seenApprovalRpcIds.add(id);
    if (
      this.approvals.size >= MAX_PENDING ||
      this.activeTurns.get(params.threadId) !== params.turnId ||
      this.interruptingTurns.has(params.turnId)
    ) {
      void this.send({ id, result: { decision: "decline" } });
      return;
    }
    const callbackId = `codex-callback-${++this.nextApprovalId}`;
    this.approvals.set(callbackId, {
      rpcId: id,
      method,
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
    });
    try {
      this.onEvent({
        kind: "approval",
        method,
        params,
        callbackId,
        approvalId: typeof params.approvalId === "string" ? params.approvalId : null,
      });
    } catch {
      this.approvals.delete(callbackId);
      void this.send({ id, result: { decision: "decline" } });
    }
  }

  private denyTurn(threadId: string, turnId: string): void {
    for (const [key, approval] of this.approvals) {
      if (approval.threadId === threadId && approval.turnId === turnId) {
        this.approvals.delete(key);
        void this.send({ id: approval.rpcId, result: { decision: "decline" } });
      }
    }
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.approvals.clear();
    this.seenApprovalRpcIds.clear();
    this.activeTurns.clear();
    this.startingTurns.clear();
    this.earlyCompleted.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGTERM");
    this.onFailure?.();
  }
}
