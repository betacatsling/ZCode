import type { ModelSelection } from "@zcode/shared/model-selection";
import type { CapabilityReport, HarnessCapabilities } from "@zcode/shared/agent-host";

/**
 * 三个 unsupported 字段共用一句，避免只点名其中一项时把另外两项读成已认证。
 * probe / hostManagedSupport 的 supported 不能升级这些字段。
 */
const HARNESS_UNSUPPORTED =
  "Pi host bridge does not certify resumeExecution, images, or modelSwitch. A supported probe or hostManagedSupport result does not upgrade these fields.";

const CONTROL_UNSUPPORTED =
  "Pi control plane does not certify resumeExecution, images, or modelSwitch. viewHistory reads the recorded host log; a model switch applies on a later turn, not the active one. A supported probe does not upgrade these fields.";

/** 唯一所有者：PiHarnessAdapter.capabilities() 原样返回。 */
export function piHarnessCapabilities(): HarnessCapabilities {
  const no = { support: "unsupported" as const, reason: HARNESS_UNSUPPORTED };
  return {
    text: {
      support: "supported",
      reason: "Pi host bridge certifies text turns. images and modelSwitch stay unsupported.",
    },
    tools: {
      support: "supported",
      reason:
        "Pi host bridge certifies read, write, edit, and bash. Uncertified tool names are blocked before execution.",
      constraints: { read: true, write: true, edit: true, bash: true },
    },
    approvals: {
      support: "supported",
      reason:
        "Approvals gate write, edit, and bash on the Pi worker. read may run unattended. resumeExecution, images, and modelSwitch stay unsupported.",
    },
    cancelTurn: {
      support: "supported",
      reason: "cancelTurn aborts the active Pi worker turn.",
    },
    history: {
      support: "supported",
      reason:
        "History is the Pi native session file used on attach. resumeExecution of an in-flight turn is unsupported.",
    },
    resumeExecution: no,
    images: no,
    modelSwitch: no,
  };
}

/** 唯一所有者：PiAdapter.capabilities() 原样返回。工具集是 read/write/exec，不是 worker 的 edit/bash。 */
export function piControlPlaneCapabilities(route: "pi-sdk" = "pi-sdk"): HarnessCapabilities {
  const yes = { support: "supported" as const };
  const no = { support: "unsupported" as const, reason: CONTROL_UNSUPPORTED };
  return {
    text: {
      support: "supported",
      reason: "Pi control plane certifies text turns. images and modelSwitch stay unsupported.",
    },
    tools: {
      support: "supported",
      reason:
        "Pi control plane certifies read, write, and exec. Uncertified tool names are rejected.",
      constraints: { read: true, write: true, exec: true },
    },
    approvals: {
      ...yes,
      reason: "Approvals can block execution until the host sends approval.decision=allow.",
    },
    cancelTurn: {
      ...yes,
      reason: "cancelTurn aborts the active control-plane turn.",
    },
    history: {
      ...yes,
      reason: "history is the recorded host log. It is not resumeExecution.",
    },
    resumeExecution: no,
    images: no,
    modelSwitch: no,
    detach: {
      support: "supported",
      reason: "detach only removes the subscription and does not close the transport.",
    },
    terminateSession: {
      support: "supported",
      reason: "terminateSession closes the transport. detach does not.",
    },
    viewHistory: {
      support: "supported",
      reason: "viewHistory reads the recorded host log and does not send a new prompt.",
    },
    hostManagedModel: {
      support: "experimental",
      reason:
        "Pi control plane records the route only. It does not call Model.streamText; the Pi worker does. experimental does not certify resumeExecution, images, or modelSwitch.",
      constraints: { route, credentialInjection: "refused" },
    },
  };
}

export function piHarnessHostManagedSupport(
  probe: CapabilityReport,
  selection: ModelSelection,
): CapabilityReport {
  if (probe.support !== "supported") return probe;
  const level = selection.options?.reasoningLevel;
  if (level !== "off" && level !== "low") {
    return {
      support: "unsupported",
      reason:
        "Pi host bridge certifies only reasoningLevel=off or low. This does not certify resumeExecution, images, or modelSwitch.",
    };
  }
  return {
    support: "supported",
    reason:
      "Pi host bridge admits host-managed routing only for reasoningLevel off or low. supported does not certify resumeExecution, images, or modelSwitch.",
    ...(probe.constraints ? { constraints: probe.constraints } : {}),
  };
}

export function piControlPlaneHostManagedSupport(
  probe: CapabilityReport,
  selection: ModelSelection,
  route: "pi-sdk" = "pi-sdk",
): CapabilityReport {
  if (probe.support !== "supported") return probe;
  if (!selection.providerId || !selection.modelId) {
    return { support: "unsupported", reason: "host-managed selection is missing" };
  }
  return {
    support: "experimental",
    reason:
      "Pi control plane has no model factory. Host-managed execution stays on PiHarnessAdapter.prepareModel and Model.streamText. experimental does not certify resumeExecution, images, or modelSwitch.",
    constraints: { route, execution: "not-this-adapter" },
  };
}
