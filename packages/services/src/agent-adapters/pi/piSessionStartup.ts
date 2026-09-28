import type { Worker } from "node:worker_threads";
import type { FromPiWorker } from "./piProtocol.js";

/** Deduplicates only create/attach startup work; accepted sends remain owned by SessionHost. */
export class PiSessionStartupReservations<T> {
  readonly #starting = new Map<string, Promise<T>>();

  has(hostSessionId: string): boolean {
    return this.#starting.has(hostSessionId);
  }

  reserve(hostSessionId: string, start: () => Promise<T>): Promise<T> {
    if (this.#starting.has(hostSessionId)) throw new Error("Pi session is already starting");
    let resolveStart!: (value: T) => void;
    let rejectStart!: (error: unknown) => void;
    const pending = new Promise<T>((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    // 修复依据：先占住 session ID 再启动异步 Worker，避免并发 create 各自启动一个 owner。
    this.#starting.set(hostSessionId, pending);
    void Promise.resolve().then(start).then(resolveStart, rejectStart);
    return pending;
  }

  release(hostSessionId: string, pending: Promise<T>): void {
    if (this.#starting.get(hostSessionId) === pending) this.#starting.delete(hostSessionId);
  }

  async settle(): Promise<void> {
    while (this.#starting.size) await Promise.allSettled(this.#starting.values());
  }
}

export async function waitForPiWorkerReady(worker: Worker): Promise<string> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: FromPiWorker) => {
      if (message.type === "ready") {
        worker.off("error", reject);
        worker.off("exit", onExit);
        worker.off("message", onMessage);
        resolve(message.backendSessionId);
      } else if (message.type === "fatal") {
        reject(new Error(message.message));
      }
    };
    const onExit = () => reject(new Error("Pi worker exited before session initialization"));
    worker.on("message", onMessage);
    worker.once("error", reject);
    worker.once("exit", onExit);
  });
}
