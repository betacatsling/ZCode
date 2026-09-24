import { randomUUID } from "node:crypto";

export interface MaintenanceActivity {
  running: number;
  waiting: number;
  tools: number;
  uncertain: number;
  offline: boolean;
}
/** JSON-safe capability; valid only for this Core instance and this single maintenance operation. */
export interface MaintenanceLease {
  token: string;
  epoch: number;
}
export interface MaintenanceLeasePort {
  /** Automatic maintenance only. Freezes native + workspace admission, drains and verifies fresh activity. */
  freezeAdmissions(): Promise<MaintenanceLease>;
  /** Only the exact held lease may reopen admissions; failed native release keeps them closed. */
  releaseAdmissions(lease: MaintenanceLease): Promise<void>;
}
export interface MaintenanceCoordination extends MaintenanceLeasePort {
  /** Local-only convenience; do not serialize callbacks across RPC. */
  withMaintenance<T>(action: () => Promise<T>): Promise<T>;
  admissionEnabled(): boolean;
  withAdmission<T>(action: () => Promise<T>): Promise<T>;
}

/** The runtime must inject its real CLI fence; there is no substitute local CLI queue. */
export function createMaintenanceCoordination(input: {
  nativeFence: () => Promise<() => Promise<void>>;
  activity: () => Promise<MaintenanceActivity>;
}): MaintenanceCoordination {
  let phase: "open" | "acquiring" | "held" | "releasing" | "poisoned" = "open";
  let epoch = 0;
  let held: MaintenanceLease | undefined;
  let unfreezeNative: (() => Promise<void>) | undefined;
  let inflight = 0;
  const drain = new Set<() => void>();
  const releaseOwnedFence = async (): Promise<void> => {
    // 中文：原生 fence 解除失败意味着 CLI admission 不确定；不能把 workspace 错误标成开放。
    phase = "releasing";
    try {
      await unfreezeNative?.();
    } catch (error) {
      phase = "poisoned";
      throw error;
    }
    unfreezeNative = undefined;
    held = undefined;
    phase = "open";
  };
  const port: MaintenanceCoordination = {
    admissionEnabled: () => phase === "open",
    async withAdmission(action) {
      if (phase !== "open") throw new Error("New admission frozen for maintenance");
      inflight++;
      try {
        return await action();
      } finally {
        inflight--;
        if (inflight === 0) for (const release of drain) release();
      }
    },
    async freezeAdmissions() {
      // 中文：在第一个 await 前关住 workspace admission；并发 freeze 不能获得同一个租约。
      if (phase !== "open") throw new Error("Maintenance already in progress or fence uncertain");
      phase = "acquiring";
      const nextEpoch = ++epoch;
      try {
        unfreezeNative = await input.nativeFence();
        if (typeof unfreezeNative !== "function")
          throw new Error("Native CLI fence did not provide a release capability");
      } catch (error) {
        // 中文：CLI fence 调用失败可能已经生效，不能猜测原生 admission 已重新开放。
        phase = "poisoned";
        throw error;
      }
      try {
        if (inflight) {
          await new Promise<void>((resolve) => {
            drain.add(resolve);
          });
          drain.clear();
        }
        const current = await input.activity();
        if (
          current.offline !== false ||
          ![current.running, current.waiting, current.tools, current.uncertain].every(
            (count) => Number.isSafeInteger(count) && count === 0,
          )
        )
          throw new Error("Runtime busy or uncertain; maintenance refused");
        held = { token: randomUUID(), epoch: nextEpoch };
        phase = "held";
        return { ...held };
      } catch (error) {
        await releaseOwnedFence();
        throw error;
      }
    },
    async releaseAdmissions(lease) {
      if (phase !== "held" || !held || lease?.token !== held.token || lease.epoch !== held.epoch)
        throw new Error("Invalid or stale maintenance lease");
      await releaseOwnedFence();
    },
    async withMaintenance(action) {
      const lease = await port.freezeAdmissions();
      try {
        return await action();
      } finally {
        await port.releaseAdmissions(lease);
      }
    },
  };
  return port;
}
