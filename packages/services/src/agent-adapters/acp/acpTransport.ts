export interface AcpJsonRpcMessage {
  jsonrpc: "2.0";
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpTransport {
  send(message: AcpJsonRpcMessage): Promise<void>;
  subscribe(listener: (message: AcpJsonRpcMessage) => void): () => void;
  close(): Promise<void>;
}

export function linkAcpTransports(): { client: AcpTransport; agent: AcpTransport } {
  let closed = false;
  const clientListeners = new Set<(message: AcpJsonRpcMessage) => void>();
  const agentListeners = new Set<(message: AcpJsonRpcMessage) => void>();
  const make = (
    local: Set<(message: AcpJsonRpcMessage) => void>,
    remote: Set<(message: AcpJsonRpcMessage) => void>,
  ): AcpTransport => ({
    async send(message) {
      if (closed) throw new Error("ACP transport closed");
      for (const listener of remote) listener(message);
    },
    subscribe(listener) {
      local.add(listener);
      return () => local.delete(listener);
    },
    async close() {
      closed = true;
      local.clear();
      remote.clear();
    },
  });
  return {
    client: make(clientListeners, agentListeners),
    agent: make(agentListeners, clientListeners),
  };
}

/** 换行分帧。半行保留，坏行交给调用方，不抛出进程。 */
export function pushAcpNdjson(
  onMessage: (message: AcpJsonRpcMessage) => void,
  onInvalid: (line: string) => void,
): { push(chunk: string): void } {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line.trim()) deliverAcpLine(line, onMessage, onInvalid);
        newline = buffer.indexOf("\n");
      }
    },
  };
}

export function encodeAcpMessage(message: AcpJsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

function deliverAcpLine(
  line: string,
  onMessage: (message: AcpJsonRpcMessage) => void,
  onInvalid: (line: string) => void,
): void {
  try {
    const value: unknown = JSON.parse(line);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      onInvalid(line);
      return;
    }
    const record = value as Record<string, unknown>;
    if (record.jsonrpc !== "2.0") {
      onInvalid(line);
      return;
    }
    onMessage(value as AcpJsonRpcMessage);
  } catch {
    onInvalid(line);
  }
}

export class AcpRpc {
  readonly sentMethods: string[] = [];
  #next = 1;
  #closed = false;
  readonly #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #unsubscribe: () => void;

  constructor(
    private readonly transport: AcpTransport,
    private readonly onRequest: (message: AcpJsonRpcMessage) => void,
    private readonly onNotification: (message: AcpJsonRpcMessage) => void,
  ) {
    this.#unsubscribe = transport.subscribe((message) => this.#receive(message));
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.#closed) throw new Error("ACP transport closed");
    const id = this.#next++;
    this.sentMethods.push(method);
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    await this.transport.send({ jsonrpc: "2.0", id, method, params });
    return promise;
  }

  async notify(method: string, params: unknown): Promise<void> {
    if (this.#closed) throw new Error("ACP transport closed");
    this.sentMethods.push(method);
    await this.transport.send({ jsonrpc: "2.0", method, params });
  }

  async respond(id: string | number, result: unknown): Promise<void> {
    if (this.#closed) return;
    await this.transport.send({ jsonrpc: "2.0", id, result });
  }

  async fail(id: string | number, code: number, message: string): Promise<void> {
    if (this.#closed) return;
    await this.transport.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  close(): void {
    this.#closed = true;
    this.#unsubscribe();
    for (const pending of this.#pending.values()) pending.reject(new Error("ACP transport closed"));
    this.#pending.clear();
  }

  #receive(message: AcpJsonRpcMessage): void {
    if (message.method === undefined && typeof message.id === "number") {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    if (message.method && message.id !== undefined && message.id !== null) {
      this.onRequest(message);
      return;
    }
    if (message.method) this.onNotification(message);
  }
}
