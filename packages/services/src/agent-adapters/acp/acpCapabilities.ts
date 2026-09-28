import type { CapabilityReport, HarnessCapabilities } from "@zcode/shared/agent-host";
import type { AcpNegotiation } from "./acpProtocol.js";

const supported = { support: "supported" as const };
const hostManagedModel: CapabilityReport = {
  support: "unsupported",
  reason: "ACP long-tail agents are not certified for host-managed model injection",
};
const modelSwitch: CapabilityReport = {
  support: "unsupported",
  reason: "ACP model switching is not negotiated by this adapter",
};
const viewHistory: CapabilityReport = {
  support: "supported",
  constraints: { source: "host-events", continuesExecution: false },
};

export function acpProbeReport(negotiation: AcpNegotiation): CapabilityReport {
  if (negotiation.stability !== "stable") {
    return { support: "experimental", reason: negotiation.stabilityReason ?? "ACP protocol is experimental" };
  }
  if (negotiation.authMethods.length > 0) {
    return {
      support: "unsupported",
      reason: `ACP auth methods were advertised (${negotiation.authMethods.map((method) => method.methodId).join(", ")}) and this adapter does not submit credentials`,
    };
  }
  return supported;
}

export function acpHarnessCapabilities(negotiation: AcpNegotiation | undefined): HarnessCapabilities {
  const session = sessionReport(negotiation);
  return {
    text: session,
    tools: session,
    approvals: session,
    cancelTurn: session,
    resumeExecution: resumeReport(negotiation),
    history: viewHistory,
    images: imageReport(negotiation),
    modelSwitch,
    detach: { support: "supported", constraints: { closesTransport: false } },
    terminateSession: supported,
    viewHistory,
    hostManagedModel,
  };
}

function sessionReport(negotiation: AcpNegotiation | undefined): CapabilityReport {
  if (!negotiation) return { support: "unknown", reason: "ACP session capabilities have not been negotiated" };
  if (negotiation.stability !== "stable") {
    return { support: "experimental", reason: negotiation.stabilityReason ?? "ACP protocol is experimental" };
  }
  return supported;
}

function resumeReport(negotiation: AcpNegotiation | undefined): CapabilityReport {
  if (!negotiation) return { support: "unknown", reason: "ACP session resume has not been negotiated" };
  if (negotiation.stability !== "stable") {
    return { support: "experimental", reason: negotiation.stabilityReason ?? "ACP protocol is experimental" };
  }
  if (negotiation.loadSession) {
    return { support: "supported", constraints: { method: "session/load", replaysHistory: true } };
  }
  if (negotiation.resumeSession) {
    return { support: "supported", constraints: { method: "session/resume", replaysHistory: false } };
  }
  return { support: "unsupported", reason: "Agent did not negotiate session/load or session/resume" };
}

function imageReport(negotiation: AcpNegotiation | undefined): CapabilityReport {
  if (!negotiation?.imagesAdvertised) {
    return { support: "unsupported", reason: "Agent did not negotiate image prompts" };
  }
  return {
    support: "experimental",
    reason: "ACP advertised image prompts; this adapter only forwards text",
  };
}
