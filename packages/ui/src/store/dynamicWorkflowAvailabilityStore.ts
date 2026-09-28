import { create } from "zustand";
import type { DynamicWorkflowClientConfig } from "@zcode/shared";

// ============================================================
// 动态工作流灰度快照在 renderer 的唯一副本
// ============================================================
//
// 产品订阅服务已拆除，renderer 不再向 Host 拉取灰度。
// 未开启是唯一发布结果：入口保持关闭，也不再因换 service 实例重试。

export type DynamicWorkflowAvailabilityStatus = "loading" | "ready";

export interface DynamicWorkflowAvailabilitySnapshot {
  readonly status: DynamicWorkflowAvailabilityStatus;
  /** loading 期间恒为 false：未知即不提供，入口宁可晚半拍出现也不闪一下再收起。 */
  readonly enabled: boolean;
  /** 产品订阅拆除后固定为 null。 */
  readonly config: DynamicWorkflowClientConfig | null;
}

interface DynamicWorkflowAvailabilityState extends DynamicWorkflowAvailabilitySnapshot {
  /** 发布未开启快照。重复调用是 no-op。 */
  ensureLoaded(): Promise<void>;
  /** 与 ensureLoaded 相同：没有可强制刷新的订阅来源。 */
  refresh(): Promise<void>;
}

const DISABLED_SNAPSHOT: DynamicWorkflowAvailabilitySnapshot = {
  status: "ready",
  enabled: false,
  config: null,
};

export const useDynamicWorkflowAvailabilityStore = create<DynamicWorkflowAvailabilityState>(
  (set, get) => ({
    status: "loading",
    enabled: false,
    config: null,

    ensureLoaded(): Promise<void> {
      if (get().status === "ready") return Promise.resolve();
      set(DISABLED_SNAPSHOT);
      return Promise.resolve();
    },

    refresh(): Promise<void> {
      set(DISABLED_SNAPSHOT);
      return Promise.resolve();
    },
  }),
);
