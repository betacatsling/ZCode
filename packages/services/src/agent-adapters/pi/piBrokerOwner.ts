import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FromPiWorker } from "./piProtocol.js";

type BrokerCall = Extract<FromPiWorker, { type: "broker.request" }>;
type Entry = {
  child: ChildProcess;
  waiting: Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>;
  counter: number;
  closed: boolean;
  exit: Promise<void>;
  closePromise?: Promise<void>;
};

/** Parent transport, not the SDK worker, owns every broker ChildProcess and its exit receipt. */
export class PiBrokerOwner {
  readonly #entries = new Map<string, Entry>();
  readonly #onExit?: (callId: string) => void;
  #closed = false;
  constructor(onExit?: (callId: string) => void) {
    this.#onExit = onExit;
  }
  async request(call: BrokerCall): Promise<unknown> {
    if (this.#closed) throw new Error("Pi broker owner closed");
    const { callId } = call;
    if (call.action === "open") {
      if (
        this.#entries.size >= 8 ||
        this.#entries.has(callId) ||
        !call.cwd ||
        !call.leaf ||
        !call.mode ||
        !call.rootDev ||
        !call.rootIno
      )
        throw new Error("Pi broker admission unavailable");
      const source = import.meta.url.endsWith(".ts");
      const child = fork(
        fileURLToPath(new URL(source ? "./piFileBroker.ts" : "./piFileBroker.js", import.meta.url)),
        [],
        {
          cwd: call.cwd,
          execPath: process.execPath,
          execArgv: source ? ["--experimental-strip-types"] : [],
          env: {},
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      const waiting: Entry["waiting"] = new Map();
      const entry: Entry = { child, waiting, counter: 0, closed: false, exit: undefined! };
      entry.exit = new Promise<void>((resolve) => {
        child.once("exit", () => {
          for (const pending of waiting.values()) pending.reject(new Error("Pi broker exited"));
          waiting.clear();
          if (entry.closed && this.#entries.get(callId) === entry) this.#entries.delete(callId);
          try {
            this.#onExit?.(callId);
          } catch {
            /* Node-only observer cannot block reaping. */
          }
          resolve();
        });
      });
      child.on("error", () => {
        for (const pending of waiting.values()) pending.reject(new Error("Pi broker failed"));
        waiting.clear();
      });
      child.on("message", (raw: unknown) => {
        const reply = raw as { id?: number; result?: unknown; error?: string };
        const pending = waiting.get(reply?.id ?? -1);
        if (!pending) return;
        waiting.delete(reply.id!);
        if (reply.error) pending.reject(new Error(`Pi broker refused operation: ${reply.error}`));
        else pending.resolve(reply.result);
      });
      this.#entries.set(callId, entry);
      try {
        await this.#send(entry, "init", undefined, call);
        if (this.#closed) throw new Error("Pi broker owner closed during preparation");
        return null;
      } catch (error) {
        await this.#close(callId);
        throw error;
      }
    }
    if (call.action === "close") {
      await this.#close(callId);
      return null;
    }
    const entry = this.#entries.get(callId);
    if (!entry || entry.closed) throw new Error("Pi broker not prepared");
    return this.#send(entry, call.action, call.content);
  }
  #send(entry: Entry, op: string, content?: string, init?: BrokerCall): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!entry.child.connected || entry.closed) {
        reject(new Error("Pi broker disconnected"));
        return;
      }
      const id = ++entry.counter;
      entry.waiting.set(id, { resolve, reject });
      entry.child.send(
        {
          id,
          op,
          content,
          ...(init
            ? { leaf: init.leaf, mode: init.mode, rootDev: init.rootDev, rootIno: init.rootIno }
            : {}),
        },
        (error) => {
          if (error) {
            entry.waiting.delete(id);
            reject(error);
          }
        },
      );
    });
  }
  async #close(callId: string): Promise<void> {
    const entry = this.#entries.get(callId);
    if (!entry) return;
    if (entry.closePromise) return entry.closePromise;
    entry.closed = true;
    // 修复：保留 closing entry 直至真实 exit；worker 若在 close 处理中死亡，
    // parent cleanup 仍必须等待该同一个回收 promise，不能把删除 Map 当成完成。
    entry.closePromise = (async () => {
      if (entry.child.connected) entry.child.send({ id: ++entry.counter, op: "close" });
      const term = setTimeout(() => entry.child.kill("SIGTERM"), 250);
      const kill = setTimeout(() => entry.child.kill("SIGKILL"), 750);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          entry.exit,
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Pi broker did not exit after forced cleanup")),
              1500,
            );
          }),
        ]);
      } finally {
        clearTimeout(term);
        clearTimeout(kill);
        if (deadline) clearTimeout(deadline);
        if (
          (this.#entries.get(callId) === entry && entry.child.exitCode !== null) ||
          (this.#entries.get(callId) === entry && entry.child.signalCode !== null)
        )
          this.#entries.delete(callId);
      }
    })();
    return entry.closePromise;
  }
  async close(): Promise<void> {
    this.#closed = true;
    const outcomes = await Promise.allSettled(
      [...this.#entries.keys()].map((id) => this.#close(id)),
    );
    const rejected = outcomes.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") throw rejected.reason;
  }
  pendingCount(): number {
    return this.#entries.size;
  }
}
