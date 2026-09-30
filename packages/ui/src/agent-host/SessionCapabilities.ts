/** 与计划第 4 节 CapabilityReport 一致。合并契约后改为 `@zcode/shared` 公开入口。 */

export type CapabilitySupport = "supported" | "unsupported" | "experimental" | "unknown";

export interface CapabilityReport {
  support: CapabilitySupport;
  reason?: string;
  constraints?: Record<string, unknown>;
}

/** 计划第 4.2 节要求分开报告的会话能力。未知和实验性都不等于可执行。 */
export interface SessionCapabilities {
  detach: CapabilityReport;
  cancelTurn: CapabilityReport;
  terminateSession: CapabilityReport;
  resumeExecution: CapabilityReport;
  viewHistory: CapabilityReport;
  tools: CapabilityReport;
  images: CapabilityReport;
  reasoning: CapabilityReport;
}

export function admitsExecution(report: CapabilityReport): boolean {
  return report.support === "supported";
}

export function isUnverifiedCapability(report: CapabilityReport): boolean {
  return report.support === "experimental" || report.support === "unknown";
}
