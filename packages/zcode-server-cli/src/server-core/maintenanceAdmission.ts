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
  private pending = false;

  constructor(private readonly port: CoreMaintenanceAdmissionPort | undefined) {}

  /** Missing wiring or read errors are unsafe; never substitute an idle snapshot. */
  async begin(): Promise<{ leaseId: string; native: RuntimeActivity; external: RuntimeActivity }> {
    if (!this.port) throw new Error("Runtime maintenance admission coordinator unavailable");
    if (this.pending || this.lease) throw new Error("Runtime maintenance lease already held");
    this.pending = true;
    try {
      const lease = await this.port.freezeAdmissions();
      const id = randomUUID();
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
    }
  }

  async release(id: string): Promise<void> {
    const lease = this.lease;
    if (!lease || lease.id !== id) throw new Error("Runtime maintenance lease mismatch");
    await lease.release();
    if (this.lease === lease) this.lease = undefined;
  }
}
