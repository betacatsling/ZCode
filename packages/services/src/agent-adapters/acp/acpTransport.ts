import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { probeAcpDescriptor, record, rpcId, type ObjectValue } from "./acpWire.js";
export { probeAcpDescriptor } from "./acpWire.js";
import type { Readable, Writable } from "node:stream";
import type { EventEmitter } from "node:events";

const PROTOCOL_VERSION = 1;
const MAX_FRAME = 1024 * 1024;
const MAX_PENDING = 128;
export interface AcpProcess extends Pick<EventEmitter, "on"> {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface AcpDescriptor {
  executable: string;
  argv: readonly string[];
  cwd: string;
  /** Complete, caller-isolated environment, including HOME/profile. No ambient credentials are inherited. */
  env: NodeJS.ProcessEnv;
  version: { argv: readonly string[]; exact: string };
}
export interface AcpPermission {
  id: string | number;
  sessionId: string;
  toolCall: ObjectValue;
  options: readonly ObjectValue[];
  /** Only call after host authorization; false means stale, cancelled, or invalid option. */
  resolve(optionId: string): boolean;
  deny(): boolean;
}
export interface AcpTransportOptions {
  probeVersion?: (descriptor: AcpDescriptor) => Promise<string>;
  launch?: (descriptor: AcpDescriptor) => AcpProcess;
  /** Supply only callbacks whose operations are independently authorized by the host. */
  clientRequests?: Readonly<Record<string, (params: ObjectValue) => Promise<unknown>>>;
  clientCapabilities?: ObjectValue;
  onPermission?: (request: AcpPermission) => void | Promise<void>;
}

/** Raw ACP connection; does not project events, persist host state, or bind a model. */
export class AcpTransport {
  private readonly pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >();
  private readonly inbound = new Map<
    string | number,
    { sessionId: string; options: Set<string> }
  >();
  private readonly seenInbound = new Set<string | number>();
  private readonly listeners = new Set<(update: ObjectValue) => void>();
  private readonly exitListeners = new Set<(error: Error) => void>();
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private closed = false;
  private sessionId?: string;
  private inPrompt = false;
  private promptId?: number;
  private cancelledPromptId?: number;
  /** ACP updates have only a native session ID, not a prompt ID. Never reuse a cancelled connection. */
  private poisoned = false;
  private caps: ObjectValue = {};

  private constructor(
    private readonly process: AcpProcess,
    private readonly descriptor: AcpDescriptor,
    private readonly options: AcpTransportOptions,
  ) {
    process.stdin.on("error", () => this.shutdown(new Error("ACP stdin failed")));
    process.stdout.on("data", (chunk: Buffer | string) => this.readChunk(chunk));
    process.stdout.on("error", () => this.shutdown(new Error("ACP stdout failed")));
    process.stdout.on("end", () => this.shutdown(new Error("ACP stdout ended")));
    // Stderr is drained but not copied to logs (it may contain credentials or prompts).
    process.stderr.on("data", () => {});
    process.stderr.on("error", () => {});
    process.on("error", () => this.shutdown(new Error("ACP process failed")));
    process.on("exit", () => this.shutdown(new Error("ACP process exited")));
  }

  static async connect(
    descriptor: AcpDescriptor,
    options: AcpTransportOptions = {},
  ): Promise<AcpTransport> {
    if (
      !isAbsolute(descriptor.cwd) ||
      !isAbsolute(descriptor.executable) ||
      !descriptor.version.exact ||
      !descriptor.env.HOME
    )
      throw new Error("ACP requires absolute executable/cwd and isolated HOME with exact version");
    const probe = options.probeVersion ?? probeAcpDescriptor;
    if ((await probe(descriptor)) !== descriptor.version.exact)
      throw new Error("ACP executable version mismatch");
    const advertised = options.clientCapabilities ?? {};
    // ACP client requests have no prompt identity; an async write already dispatched cannot be
    // revoked by session/cancel. Reject the entire injection rather than promise a false fence.
    if (Object.keys(options.clientRequests ?? {}).length || Object.keys(advertised).length)
      throw new Error("ACP client callbacks/capabilities lack a cancellable prompt fence");
    const child = (
      options.launch ??
      ((d) =>
        spawn(d.executable, [...d.argv], {
          cwd: d.cwd,
          env: d.env,
          stdio: ["pipe", "pipe", "pipe"],
        }) as AcpProcess)
    )(descriptor);
    const client = new AcpTransport(child, descriptor, options);
    try {
      const response = await client.call("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: options.clientCapabilities ?? {},
        clientInfo: { name: "ZCode", version: "0.3" },
      });
      if (!record(response) || response.protocolVersion !== PROTOCOL_VERSION)
        throw new Error("ACP incompatible protocol version");
      client.caps = record(response.agentCapabilities) ? response.agentCapabilities : {};
      return client;
    } catch (error) {
      client.shutdown(new Error("ACP initialization failed"));
      throw error;
    }
  }

  get capabilities(): Readonly<{ loadSession: boolean; raw: ObjectValue }> {
    return { loadSession: this.caps.loadSession === true, raw: { ...this.caps } };
  }
  onUpdate(listener: (update: ObjectValue) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  onExit(listener: (error: Error) => void): () => void {
    if (this.closed) {
      listener(new Error("ACP connection already closed"));
      return () => {};
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }
  async newSession(): Promise<string> {
    if (this.sessionId) throw new Error("ACP session already bound");
    const result = await this.call("session/new", { cwd: this.descriptor.cwd, mcpServers: [] });
    if (!record(result) || typeof result.sessionId !== "string" || !result.sessionId)
      return this.fail("ACP invalid session ID");
    this.sessionId = result.sessionId;
    return result.sessionId;
  }
  async load(sessionId: string): Promise<void> {
    if (!this.capabilities.loadSession)
      throw new Error("ACP session/load not supported (history only)");
    if (this.sessionId || !sessionId) throw new Error("ACP invalid load state");
    const result = await this.call("session/load", {
      sessionId,
      cwd: this.descriptor.cwd,
      mcpServers: [],
    });
    if (!record(result)) this.fail("ACP invalid load response");
    this.sessionId = sessionId;
  }
  async prompt(text: string): Promise<ObjectValue> {
    if (!this.sessionId || this.inPrompt || this.poisoned)
      throw new Error("ACP session missing or prompt active/cancelling/uncertain");
    this.inPrompt = true;
    try {
      const result = await this.call(
        "session/prompt",
        { sessionId: this.sessionId, prompt: [{ type: "text", text }] },
        (id) => {
          this.promptId = id;
        },
      );
      if (!record(result) || typeof result.stopReason !== "string")
        return this.fail("ACP invalid prompt response");
      if (result.stopReason !== (this.poisoned ? "cancelled" : "end_turn")) {
        this.poisoned = true;
        throw new Error("ACP prompt outcome unknown");
      }
      return result;
    } finally {
      this.inPrompt = false;
      this.promptId = undefined;
    }
  }
  async cancel(): Promise<void> {
    if (!this.sessionId || !this.inPrompt || this.cancelledPromptId !== undefined) return;
    // 取消通知不是终态；原 RPC 必须等原生 cancelled 结果，错误则维持未知态。
    this.poisoned = true;
    this.cancelledPromptId = this.promptId;
    this.notify("session/cancel", { sessionId: this.sessionId });
    this.cancelPermissions();
  }
  async close(): Promise<void> {
    this.shutdown(new Error("ACP connection closed"));
  }

  private call(method: string, params: ObjectValue, onId?: (id: number) => void): Promise<unknown> {
    if (this.closed || this.pending.size >= MAX_PENDING)
      return Promise.reject(new Error("ACP unavailable or pending limit exceeded"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      onId?.(id);
      try {
        this.send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error as Error);
      }
    });
  }
  private send(frame: ObjectValue): void {
    const data = JSON.stringify(frame) + "\n";
    if (this.closed || Buffer.byteLength(data) > MAX_FRAME)
      throw new Error("ACP unavailable or outbound frame too large");
    this.process.stdin.write(data);
  }
  private notify(method: string, params: ObjectValue): void {
    this.send({ jsonrpc: "2.0", method, params });
  }
  private readChunk(chunk: Buffer | string): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let index: number;
    while ((index = this.buffer.indexOf(10)) !== -1 && !this.closed) {
      if (index > MAX_FRAME) return this.protocolError("ACP oversized frame");
      const raw = this.buffer.subarray(0, index);
      this.buffer = this.buffer.subarray(index + 1);
      if (!raw.length) return this.protocolError("ACP empty frame");
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString("utf8")) as unknown;
      } catch {
        return this.protocolError("ACP malformed frame");
      }
      this.handle(frame);
    }
    if (this.buffer.length > MAX_FRAME) this.protocolError("ACP oversized frame");
  }
  private handle(frame: unknown): void {
    if (!record(frame) || frame.jsonrpc !== "2.0" || ("id" in frame && !rpcId(frame.id)))
      return this.protocolError("ACP invalid envelope");
    if (typeof frame.method === "string") {
      if (!record(frame.params)) return this.protocolError("ACP invalid params");
      if ("id" in frame) {
        if (this.seenInbound.has(frame.id as string | number))
          return this.protocolError("ACP duplicate request ID");
        this.seenInbound.add(frame.id as string | number);
        if (this.seenInbound.size > MAX_PENDING * 64)
          return this.protocolError("ACP inbound ID limit exceeded");
        this.handleRequest(frame.id as string | number, frame.method, frame.params);
      } else if (frame.method === "session/update") {
        if (typeof frame.params.sessionId !== "string" || !record(frame.params.update))
          return this.protocolError("ACP invalid update");
        if (frame.params.sessionId === this.sessionId)
          for (const listener of this.listeners) listener(frame.params);
      }
      return;
    }
    if (!rpcId(frame.id) || "result" in frame === "error" in frame)
      return this.protocolError("ACP invalid response");
    if (frame.id === this.cancelledPromptId) {
      if (!record(frame.result) || frame.result.stopReason !== "cancelled" || "error" in frame)
        return this.protocolError("ACP cancelled prompt outcome unknown");
      this.cancelledPromptId = undefined;
      // The pending original RPC is resolved below; poison stays set for late callbacks.
    }
    const pending = typeof frame.id === "number" ? this.pending.get(frame.id) : undefined;
    if (!pending) return; // Late response after cancellation is never re-admitted.
    this.pending.delete(frame.id as number);
    if ("error" in frame) pending.reject(new Error("ACP remote request failed"));
    else pending.resolve(frame.result);
  }
  private handleRequest(id: string | number, method: string, params: ObjectValue): void {
    if (method === "session/request_permission") {
      if (
        typeof params.sessionId !== "string" ||
        !record(params.toolCall) ||
        typeof params.toolCall.toolCallId !== "string" ||
        !Array.isArray(params.options) ||
        !params.options.every((o: unknown) => record(o) && typeof o.optionId === "string")
      )
        return this.protocolError("ACP invalid permission");
      if (params.sessionId !== this.sessionId || !this.inPrompt || !this.options.onPermission) {
        this.send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
        return;
      }
      const options = new Set((params.options as ObjectValue[]).map((o) => o.optionId as string));
      if (options.size !== params.options.length)
        return this.protocolError("ACP duplicate permission option");
      this.inbound.set(id, { sessionId: params.sessionId, options });
      const settle = (optionId?: string): boolean => {
        const pending = this.inbound.get(id);
        if (!pending || this.closed || (optionId !== undefined && !pending.options.has(optionId)))
          return false;
        this.inbound.delete(id);
        this.send({
          jsonrpc: "2.0",
          id,
          result: {
            outcome:
              optionId === undefined ? { outcome: "cancelled" } : { outcome: "selected", optionId },
          },
        });
        return true;
      };
      try {
        const authorization = this.options.onPermission({
          id,
          sessionId: params.sessionId,
          toolCall: params.toolCall,
          options: params.options as ObjectValue[],
          resolve: (option) => settle(option),
          deny: () => settle(),
        });
        // 同步 catch 不会处理异步授权拒绝；保持一次性 RPC 并默认拒绝。
        if (authorization) void Promise.resolve(authorization).catch(() => settle());
      } catch {
        settle();
      }
      return;
    }
    this.send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not authorized" } });
  }
  private cancelPermissions(): void {
    for (const id of this.inbound.keys()) {
      this.inbound.delete(id);
      if (!this.closed)
        this.send({ jsonrpc: "2.0", id, result: { outcome: { outcome: "cancelled" } } });
    }
  }
  private protocolError(message: string): void {
    this.shutdown(new Error(message));
  }
  private fail(message: string): never {
    this.shutdown(new Error(message));
    throw new Error(message);
  }
  private shutdown(error: Error): void {
    if (this.closed) return;
    this.cancelPermissions();
    this.closed = true;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.cancelledPromptId = undefined;
    this.inbound.clear();
    this.listeners.clear();
    this.process.stdin.end();
    this.process.stdout.destroy();
    this.process.stderr.destroy();
    this.process.kill();
    for (const listener of this.exitListeners) listener(error);
    this.exitListeners.clear();
  }
}
export const createAcpTransport = AcpTransport.connect;
