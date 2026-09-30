import { agentCommandReceiptSchema } from "@zcode/shared/agent-host";
import type { PiCommandResult } from "./piControlProtocol.js";

export function commandResult(
  commandId: string,
  status: "completed" | "rejected" | "duplicate" | "execution-unknown",
  reasonCode?: PiCommandResult["receipt"]["reasonCode"],
  message?: string,
): PiCommandResult {
  return { receipt: commandReceipt(commandId, status, reasonCode, message) };
}

export function commandReceipt(
  commandId: string,
  status: "completed" | "rejected" | "duplicate" | "accepted" | "execution-unknown",
  reasonCode?: PiCommandResult["receipt"]["reasonCode"],
  message?: string,
): PiCommandResult["receipt"] {
  return agentCommandReceiptSchema.parse({
    commandId,
    status,
    ...(reasonCode ? { reasonCode } : {}),
    ...(message ? { message } : {}),
  });
}

export function unsupportedCommandReason(type: "resumeExecution" | "createSession"): string {
  return type === "resumeExecution"
    ? "Pi resume is unsupported; viewHistory reads the host log only"
    : "Pi session creation uses open and is not a turn command";
}
