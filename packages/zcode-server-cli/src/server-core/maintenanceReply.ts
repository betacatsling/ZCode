import type { CoreMessage, RuntimeActivity } from "../contracts.js";

/** Map the admission owner's activity names to the versioned Supervisor IPC fields. */
export function maintenanceBeginReply(
  requestId: string,
  result: { leaseId: string; native: RuntimeActivity; external: RuntimeActivity },
): CoreMessage {
  return {
    type: "maintenance",
    requestId,
    leaseId: result.leaseId,
    nativeActivity: result.native,
    externalActivity: result.external,
  };
}
