import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import { PiBrokerOwner } from "./piBrokerOwner.js";
import type { FromPiWorker, ToPiWorker } from "./piProtocol.js";

/** One parent-owned effect registry per Pi worker; SDK stays in the worker. */
export class PiParentEffects {
  readonly #brokers: PiBrokerOwner;
  readonly #bash = new Map<string, { abort: AbortController; done: Promise<void> }>();
  readonly #bashSettled?: () => void;
  #closed = false;
  constructor(hooks?: { brokerExited?: (id: string) => void; bashSettled?: () => void }) {
    this.#brokers = new PiBrokerOwner(hooks?.brokerExited);
    this.#bashSettled = hooks?.bashSettled;
  }
  handle(
    raw: Extract<FromPiWorker, { type: "broker.request" | "bash.request" | "bash.abort" }>,
    reply: (message: ToPiWorker) => void,
  ): void {
    if (this.#closed) return;
    if (raw.type === "broker.request") {
      void this.#brokers.request(raw).then(
        (result) => reply({ type: "broker.reply", requestId: raw.requestId, result }),
        (error) => reply({ type: "broker.reply", requestId: raw.requestId, error: String(error) }),
      );
    } else if (raw.type === "bash.request") {
      const abort = new AbortController();
      // 修复：执行仍使用 SDK 本地 Bash operations；父进程持有 AbortController
      // 和 SDK 等待 child exit 的 promise，worker 非预期退出时才可确认其生命周期。
      const done = createLocalBashOperations()
        .exec(raw.command, raw.cwd, {
          signal: abort.signal,
          timeout: raw.timeout,
          env: raw.env,
          onData: (data) => reply({ type: "bash.data", requestId: raw.requestId, data }),
        })
        .then(
          ({ exitCode }) => reply({ type: "bash.reply", requestId: raw.requestId, exitCode }),
          (error) => reply({ type: "bash.reply", requestId: raw.requestId, error: String(error) }),
        )
        .finally(() => {
          this.#bash.delete(raw.requestId);
          this.#bashSettled?.();
        });
      this.#bash.set(raw.requestId, { abort, done });
    } else this.#bash.get(raw.requestId)?.abort.abort();
  }
  pendingCount(): number {
    return this.#brokers.pendingCount() + this.#bash.size;
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const task of this.#bash.values()) task.abort.abort();
    // 修复：SDK Bash 的 waitForChildProcess 在子代持续写管道等异常下可能不返回；
    // 不能让 Host 永远等待，也绝不能把超时当作成功回收。SDK abort 已发送
    // SIGKILL 到子进程组；未得到 SDK child-exit settlement 时明确上报不确定性。
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const bash = Promise.all([...this.#bash.values()].map((task) => task.done));
    const boundedBash = Promise.race([
      bash,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error("Pi Bash child cleanup uncertain")), 1500);
      }),
    ]).finally(() => {
      if (deadline) clearTimeout(deadline);
    });
    const outcomes = await Promise.allSettled([this.#brokers.close(), boundedBash]);
    const failed = outcomes.find((outcome) => outcome.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}
