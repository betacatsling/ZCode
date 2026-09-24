import type { NativeAdmissionFence } from "./maintenance.js";

/** Structural shape of the existing-only native CLI control port; no new CLI queue or worker is created. */
export interface NativeMaintenanceControl {
  freeze(target: NativeMaintenanceTarget): Promise<{ lease: NativeMaintenanceToken; activity: NativeMaintenanceSnapshot }>;
  getActivity(target: NativeMaintenanceTarget, lease: NativeMaintenanceToken): Promise<NativeMaintenanceSnapshot>;
  release(target: NativeMaintenanceTarget, lease: NativeMaintenanceToken): Promise<boolean>;
}
export interface NativeMaintenanceTarget {
  workspacePath: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
}
export interface NativeMaintenanceToken { epoch: string; leaseId: string }
export interface NativeMaintenanceSnapshot {
  epoch: string;
  frozen: boolean;
  active: number;
  accepted: number;
  pending: number;
  tools: number;
  approvals: number;
  unknown: boolean;
}

/** Node-only adapter around native-admission's getNativeMaintenanceControlPort(service). */
export function createNativeAdmissionFence(
  control: NativeMaintenanceControl,
  target: NativeMaintenanceTarget,
): () => Promise<NativeAdmissionFence> {
  return async () => {
    // 中文：freeze 仅接触现存 CLI worker；超时或不完整回执不能推断未冻结，交给协调器封锁 workspace。
    const { lease, activity } = await control.freeze(target);
    const check = (snapshot: NativeMaintenanceSnapshot): boolean => {
      if (!lease || typeof lease.epoch !== "string" || !lease.epoch || !lease.leaseId ||
          snapshot?.epoch !== lease.epoch || snapshot.frozen !== true || snapshot.unknown !== false ||
          ![snapshot.active, snapshot.accepted, snapshot.pending, snapshot.tools, snapshot.approvals]
            .every((count) => Number.isSafeInteger(count) && count >= 0))
        throw new Error("native maintenance lease or worker activity uncertain");
      return [snapshot.active, snapshot.accepted, snapshot.pending, snapshot.tools, snapshot.approvals]
        .every((count) => count === 0);
    };
    // Preserve the real lease even if an initial activity snapshot is busy: release after the drain.
    check(activity);
    return {
      verify: async () => check(await control.getActivity(target, lease)),
      release: async () => {
        if (await control.release(target, lease) !== true)
          throw new Error("native maintenance lease release uncertain");
      },
    };
  };
}
