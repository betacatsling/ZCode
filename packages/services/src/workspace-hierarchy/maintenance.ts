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
export interface NativeAdmissionFence {
  release(): Promise<void>;
  /** The original worker must still hold its native CLI fence after workspace admissions drain. */
  verify(): Promise<boolean>;
}
export interface MaintenanceCoordination extends MaintenanceLeasePort {
  /** Local-only convenience; do not serialize callbacks across RPC. */
  withMaintenance<T>(action: () => Promise<T>): Promise<T>;
  admissionEnabled(): boolean;
  /** Instance-local initial hold, independent of ordinary maintenance leases. */
  releaseInitialHold(): Promise<void>;
  /** Attach the already-frozen boot worker, never perform an idle-gated late freeze. */
  attachBootFence(fence: NativeAdmissionFence): void;
  withAdmission<T>(action: () => Promise<T>): Promise<T>;
}

/** The runtime must inject its real CLI fence; there is no substitute local CLI queue. */
export function createMaintenanceCoordination(input: {
  nativeFence: () => Promise<NativeAdmissionFence | (() => Promise<void>)>;
  activity: () => Promise<MaintenanceActivity>;
  initiallyHeld?: boolean;
  /** Trusted fixture observer only; cannot skip or alter admission. */
  testOnlyOnWorkspaceAdmission?: () => void;
}): MaintenanceCoordination {
  let initialHold = input.initiallyHeld === true;
  let bootFence: NativeAdmissionFence | undefined;
  let phase: "open" | "acquiring" | "held" | "releasing" | "poisoned" = "open";
  let epoch = 0;
  let held: MaintenanceLease | undefined;
  let native: NativeAdmissionFence | undefined;
  let inflight = 0;
  const drain = new Set<() => void>();
  const releaseOwnedFence = async (): Promise<void> => {
    // 中文：原生 fence 解除失败意味着 CLI admission 不确定；不能把 workspace 错误标成开放。
    phase = "releasing";
    try {
      await native?.release();
    } catch (error) {
      phase = "poisoned";
      throw error;
    }
    native = undefined;
    held = undefined;
    phase = "open";
  };
  const port: MaintenanceCoordination = {
    admissionEnabled: () => phase === "open" && !initialHold,
    attachBootFence(fence) {
      if (!initialHold || bootFence) throw new Error("Invalid boot fence owner");
      bootFence = fence;
    },
    async releaseInitialHold() {
      if (!initialHold) return;
      if (phase !== "open" || !bootFence)
        throw new Error("Boot fence missing or maintenance in progress");
      // 中文：先解除同代 CLI 的实际 Inbox；丢 ACK 后保持 workspace 关闭，不能重发解除并回滚。
      phase = "releasing";
      try {
        await bootFence.release();
      } catch (error) {
        phase = "poisoned";
        throw error;
      }
      bootFence = undefined;
      initialHold = false;
      phase = "open";
    },
    async withAdmission(action) {
      if (phase !== "open" || initialHold) throw new Error("New admission frozen for maintenance");
      inflight++;
      try {
        input.testOnlyOnWorkspaceAdmission?.();
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
        const acquired = bootFence
          ? { verify: () => bootFence!.verify(), release: async () => {} }
          : await input.nativeFence();
        native =
          typeof acquired === "function"
            ? {
                release: acquired,
                // 中文：旧回调只有解除能力，无法确认 CLI epoch；拒绝发放可停机的 lease。
                verify: async () => {
                  throw new Error("Unverifiable native maintenance fence");
                },
              }
            : acquired;
        if (!native || typeof native.release !== "function" || typeof native.verify !== "function")
          throw new Error("Native CLI fence did not provide a verifiable release capability");
      } catch (error) {
        // 中文：CLI fence 调用失败可能已经生效，不能猜测原生 admission 已重新开放。
        phase = "poisoned";
        throw error;
      }
      let nativeUncertain = false;
      try {
        if (inflight) {
          await new Promise<void>((resolve) => {
            drain.add(resolve);
          });
          drain.clear();
        }
        // 中文：先排空已接收 workspace admission，再核对同一 CLI worker 的 lease；
        // 身份变化/控制 RPC 失败不是 idle，不能解除可能仍有效的原生 fence。
        let nativeIdle: boolean;
        try {
          nativeIdle = await native.verify();
        } catch (error) {
          nativeUncertain = true;
          phase = "poisoned";
          throw error;
        }
        if (!nativeIdle) throw new Error("Runtime busy or uncertain; maintenance refused");
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
        if (!nativeUncertain) await releaseOwnedFence();
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
