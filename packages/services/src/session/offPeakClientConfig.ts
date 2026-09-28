import type { ModelSelectionView } from "@zcode/provider";

/**
 * 闲时任务工具曝光门。
 * 产品 Coding Plan 订阅服务拆除后，Host 不再向远端拉取这份配置；
 * `enabled !== true` 时 Agent 不下发闲时工具。
 */
export interface OffPeakClientConfig {
  readonly enabled: boolean;
  readonly modelSelectionView: ModelSelectionView;
  /** mock 演示强制通道：真实路径不下发。 */
  readonly codingPlanActive?: boolean;
}
