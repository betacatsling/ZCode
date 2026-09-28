import type { CapabilityReport, HarnessCapabilities } from "@zcode/shared/agent-host";

const CONTROL_SUPPORTED: CapabilityReport = {
  support: "supported",
  constraints: { plane: "control", liveClaude: false, credentialsRequired: false },
};

function unsupported(reason: string): CapabilityReport {
  return { support: "unsupported", reason };
}

export function claudeCodeControlCapabilities(): HarnessCapabilities {
  return {
    text: CONTROL_SUPPORTED,
    tools: CONTROL_SUPPORTED,
    approvals: CONTROL_SUPPORTED,
    cancelTurn: CONTROL_SUPPORTED,
    history: CONTROL_SUPPORTED,
    resumeExecution: unsupported("Fake transport cannot resume a live Claude execution"),
    images: unsupported("Claude Code adapter does not accept image turns"),
    modelSwitch: unsupported("Claude Code adapter does not switch models during a turn"),
    detach: CONTROL_SUPPORTED,
    terminateSession: CONTROL_SUPPORTED,
    viewHistory: CONTROL_SUPPORTED,
    hostManagedModel: {
      support: "experimental",
      reason: "Host-managed model execution is not certified by ACP or the fake transport",
      constraints: { route: "harness-managed", acpProvesHostModel: false },
    },
  };
}

export function claudeCodeHarnessManagedSupport(): CapabilityReport {
  return {
    support: "experimental",
    reason:
      "Control plane can run without Claude credentials. Global login is not read or overwritten, and this route does not reach the model execution layer.",
    constraints: { route: "harness-managed", touchesGlobalClaudeLogin: false },
  };
}
