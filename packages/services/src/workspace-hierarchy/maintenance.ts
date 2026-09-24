export interface MaintenanceActivity { running: number; waiting: number; tools: number; uncertain: number; offline: boolean }
export interface MaintenanceCoordination {
  /** Automatic update/restart/uninstall only; explicit operator stop follows a separate contract. */
  withMaintenance<T>(action: () => Promise<T>): Promise<T>;
  admissionEnabled(): boolean;
  withAdmission<T>(action: () => Promise<T>): Promise<T>;
}

/** The runtime must inject native fence BEFORE checking fresh native + Host activity. */
export function createMaintenanceCoordination(input: {
  nativeFence: () => Promise<() => Promise<void>>;
  activity: () => Promise<MaintenanceActivity>;
}): MaintenanceCoordination {
  let frozen = false;
  let inflight = 0;
  const drain = new Set<() => void>();
  return {
    admissionEnabled: () => !frozen,
    async withAdmission(action) {
      if (frozen) throw new Error("New admission frozen for maintenance");
      inflight++;
      try { return await action(); }
      finally {
        inflight--;
        if (inflight === 0) for (const release of drain) release();
      }
    },
    async withMaintenance(action) {
      if (frozen) throw new Error("Maintenance already in progress");
      frozen = true;
      let unfreezeNative: (() => Promise<void>) | undefined;
      try {
        unfreezeNative = await input.nativeFence();
        if (inflight) await new Promise<void>((resolve) => { drain.add(resolve); });
        const current = await input.activity();
        if (current.offline || ![current.running, current.waiting, current.tools, current.uncertain].every(
          (count) => Number.isSafeInteger(count) && count === 0,
        )) throw new Error("Runtime busy or uncertain; maintenance refused");
        return await action();
      } finally {
        // 中文：原生 owner 栅栏在活动检查及维护操作期间保持生效；先解除原生栅栏再开放 Host。
        try { await unfreezeNative?.(); }
        finally { frozen = false; drain.clear(); }
      }
    },
  };
}
