import type { ExecutionTarget } from "@zcode/shared/agent-host";
import { piCapabilities } from "./piCapabilities.js";

/** A target-local worker is required; Windows remains closed until descriptor ancestry is proven. */
export function piTargetSupport(target: ExecutionTarget) {
  if (!target.available)
    return { support: "unsupported" as const, reason: target.reason ?? "target unavailable" };
  if (target.platform !== "darwin" && target.platform !== "linux")
    return {
      support: "unsupported" as const,
      reason: "first release only supports macOS and Linux",
    };
  if (target.platform !== process.platform)
    return {
      support: "unsupported" as const,
      reason: "Pi worker must run on the execution target, not across an SSH stdio attachment",
    };
  return { support: "supported" as const };
}

export function piTargetCapabilities(target: ExecutionTarget) {
  const report = piTargetSupport(target);
  if (report.support !== "supported") {
    // 修复：仅在 create 阶段拒绝 Windows 会让能力查询错误宣传可安全运行的文件工具。
    const unavailable = { support: "unsupported" as const, reason: report.reason };
    return {
      ...piCapabilities(),
      text: unavailable,
      tools: unavailable,
      approvals: unavailable,
      cancelTurn: unavailable,
      history: unavailable,
    };
  }
  return piCapabilities();
}
