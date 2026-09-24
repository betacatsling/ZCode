import type { HarnessCapabilities } from "@zcode/shared/agent-host";

/** The bridge advertises only operations its isolated native worker actually supports. */
export function piCapabilities(): HarnessCapabilities {
  const yes = { support: "supported" as const };
  const no = { support: "unsupported" as const, reason: "not certified by the Pi host bridge" };
  return {
    text: yes,
    tools: yes,
    approvals: yes,
    cancelTurn: yes,
    history: yes,
    resumeExecution: no,
    images: no,
    modelSwitch: no,
  };
}
