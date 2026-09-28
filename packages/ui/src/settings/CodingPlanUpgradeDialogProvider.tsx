import {
  createContext,
  useCallback,
  useEffect,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  CodingPlanUpgradeDialog,
  type CodingPlanUpgradeDialogTarget,
} from "@/settings/CodingPlanUpgradeDialog.js";

import {
  useCodingPlanEntryPlanList,
  type CodingPlanEntryInventory,
} from "@/hooks/useCodingPlanEntryPlanList.js";

interface CodingPlanUpgradeDialogContextValue {
  inventory: CodingPlanEntryInventory;
  openCodingPlanUpgrade: (
    target: CodingPlanUpgradeDialogTarget,
    observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
  ) => boolean;
}

const CodingPlanUpgradeDialogContext = createContext<CodingPlanUpgradeDialogContextValue | null>(
  null,
);

export function CodingPlanUpgradeDialogProvider({ children }: { children: ReactNode }) {
  const inventory = useCodingPlanEntryPlanList();
  const [target, setTarget] = useState<CodingPlanUpgradeDialogTarget | undefined>(undefined);
  const [openVersion, setOpenVersion] = useState(0);
  const opening = useRef<((opened: boolean) => void) | null>(null);
  const handleOpenResult = useCallback((opened: boolean) => opening.current?.(opened), []);
  useEffect(() => () => opening.current?.(false), []);
  const openCodingPlanUpgrade = useCallback(
    (
      nextTarget: CodingPlanUpgradeDialogTarget,
      observation?: { signal: AbortSignal; onResult: (opened: boolean) => void },
    ) => {
      if (observation?.signal.aborted) return false;
      opening.current?.(false);
      if (observation) {
        const finish = (opened: boolean) => {
          if (opening.current !== finish) return;
          opening.current = null;
          observation.signal.removeEventListener("abort", abort);
          if (!opened) setTarget(undefined);
          observation.onResult(opened);
        };
        const abort = () => finish(false);
        opening.current = finish;
        observation.signal.addEventListener("abort", abort, { once: true });
      }
      // 购买 webview 已下线。这里只打开说明弹窗，不再等待套餐查询，也不再上报购买漏斗。
      setTarget(nextTarget);
      setOpenVersion((version) => version + 1);
      return true;
    },
    [],
  );
  const value = useMemo(
    () => ({ openCodingPlanUpgrade, inventory }),
    [openCodingPlanUpgrade, inventory],
  );

  return (
    <CodingPlanUpgradeDialogContext.Provider value={value}>
      {children}
      <CodingPlanUpgradeDialog
        key={openVersion}
        target={target}
        onClose={() => {
          handleOpenResult(false);
          setTarget(undefined);
        }}
        onOpenResult={opening.current ?? undefined}
        onReopen={setTarget}
      />
    </CodingPlanUpgradeDialogContext.Provider>
  );
}

export function useCodingPlanUpgradeDialog() {
  const context = useContext(CodingPlanUpgradeDialogContext);
  if (!context) {
    throw new Error(
      "useCodingPlanUpgradeDialog must be used within CodingPlanUpgradeDialogProvider",
    );
  }
  return context;
}

export function useOptionalCodingPlanUpgradeDialog() {
  return useContext(CodingPlanUpgradeDialogContext);
}
