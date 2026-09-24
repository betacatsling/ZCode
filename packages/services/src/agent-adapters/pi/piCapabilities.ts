import type { HarnessCapabilities } from "@zcode/shared/agent-host";

/** The bridge advertises only operations its isolated native worker actually supports. */
export function piCapabilities(): HarnessCapabilities {
  const yes = { support: "supported" as const };
  // approval 只决定 Pi 工具是否可调用；bash 仍以目标用户权限运行，不构成进程级文件沙箱。
  const tools = {
    support: "supported" as const,
    reason:
      "Tool approval is not a filesystem sandbox; authorized bash retains target-user file access",
  };
  const no = { support: "unsupported" as const, reason: "not certified by the Pi host bridge" };
  return {
    text: yes,
    tools,
    approvals: yes,
    cancelTurn: yes,
    history: yes,
    resumeExecution: no,
    images: no,
    modelSwitch: no,
  };
}
