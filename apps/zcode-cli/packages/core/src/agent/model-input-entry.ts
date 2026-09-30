import type { ModelInputMessage as ContractModelInputMessage } from "@zcode/contracts";
import type { ModelInputMessage } from "./message-history.js";

/**
 * Narrow a shared-contract model message to core history's role set at the entry boundary.
 *
 * Contracts allow the Responses-only "developer" role, but core history, compaction and the
 * turn loop only model system/user/assistant/tool. The AI SDK adapter already sends
 * developer-priority text as a system-role message (adapters/src/model/transform.ts), so
 * "developer" maps to "system" here instead of widening core history.
 */
export function toCoreModelInputMessage(message: ContractModelInputMessage): ModelInputMessage {
  const { role } = message;
  if (role === "developer") return { ...message, role: "system" };
  return { ...message, role };
}
