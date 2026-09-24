import { randomUUID } from "node:crypto";
import { runtimeActivitySchema, type RuntimeActivity } from "../contracts.js";

/** Implemented by services composition: freeze *all* native and external ingress, drain
 * in-flight admissions, then return one lease held until release or Core exit. */
export interface CoreMaintenanceAdmissionPort {
  freezeAdmissions(): Promise<{ release(): Promise<void> }>;
  readActivity(): Promise<{ native: RuntimeActivity; external: RuntimeActivity }>;
}

export class CoreMaintenanceAdmission {
  private lease: { id: string; release(): Promise<void> } | undefined;
  private lastReleasedId: string | undefined;
  private releasePending: Promise<void> | undefined;
  private pending = false;
  private closed = false;
  private pendingSettled: Promise<void> | undefined;
  private finishPending: (() => void) | undefined;

  constructor(private readonly port: CoreMaintenanceAdmissionPort | undefined) {}

  /** Adopt only the factory's pre-initialization boot hold; never acquire a second fence. */
  adoptBootLease(lease: { release(): Promise<void> }): string {
    if (this.pending || this.lease || this.closed)
      throw new Error("Core admission lease already held or closing");
    const id = randomUUID();
    this.lastReleasedId = undefined;
    this.lease = { id, release: lease.release };
    return id;
  }

  /** Missing wiring or read errors are unsafe; never substitute an idle snapshot. */
  async begin(): Promise<{ leaseId: string; native: RuntimeActivity; external: RuntimeActivity }> {
    if (!this.port) throw new Error("Runtime maintenance admission coordinator unavailable");
    if (this.pending || this.lease || this.closed)
      throw new Error("Runtime maintenance lease already held or Core closing");
    this.pending = true;
    this.pendingSettled = new Promise<void>((resolve) => {
      this.finishPending = resolve;
    });
    try {
      const lease = await this.port.freezeAdmissions();
      if (this.closed) {
        // 中文：shutdown 可在 CLI fence 等待期间发生；不能在关闭后返回未被拥有的租约。
        await lease.release();
        throw new Error("Core closed during maintenance freeze");
      }
      const id = randomUUID();
      this.lastReleasedId = undefined;
      this.lease = { id, release: lease.release };
      try {
        const activity = await this.port.readActivity();
        return {
          leaseId: id,
          native: runtimeActivitySchema.parse(activity.native),
          external: runtimeActivitySchema.parse(activity.external),
        };
      } catch {
        // 冻结之后读取失败不得声明空闲；返回 lease 供 Supervisor 匹配释放。
        return {
          leaseId: id,
          native: { running: 0, waiting: 0, uncertain: 1 },
          external: { running: 0, waiting: 0, uncertain: 1 },
        };
      }
    } finally {
      this.pending = false;
      this.finishPending?.();
      this.finishPending = undefined;
      this.pendingSettled = undefined;
    }
  }

  /** Core termination may occur during an automatic maintenance operation. */
  async releaseHeld(): Promise<void> {
    this.closed = true;
    await this.pendingSettled;
    const id = this.lease?.id;
    if (id) await this.release(id);
  }

  async release(id: string): Promise<void> {
    const lease = this.lease;
    if (!lease || lease.id !== id) {
      if (!lease && this.lastReleasedId === id) return;
      throw new Error("Runtime maintenance lease mismatch");
    }
    // 中文：IPC 回执可能丢失，同 token 并发/重试必须共享一次真正的释放；
    // 只有底层 release 成功才记为已完成，下一代 lease 会使旧 token 失效。
    if (!this.releasePending) {
      this.releasePending = lease.release().then(() => {
        if (this.lease === lease) {
          this.lease = undefined;
          this.lastReleasedId = id;
        }
      });
    }
    try {
      await this.releasePending;
    } finally {
      this.releasePending = undefined;
    }
  }
}
