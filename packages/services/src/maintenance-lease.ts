// Node-only, authenticated Core↔Supervisor internal IPC boundary. The caller owns transport authentication.
export {
  createMaintenanceCoordination,
  type MaintenanceActivity,
  type MaintenanceCoordination,
  type MaintenanceLease,
  type MaintenanceLeasePort,
} from "./workspace-hierarchy/maintenance.js";
import type { MaintenanceLease, MaintenanceLeasePort } from "./workspace-hierarchy/maintenance.js";
export { createNativeAdmissionFence } from "./workspace-hierarchy/nativeMaintenanceFence.js";
export type {
  NativeMaintenanceControl,
  NativeMaintenanceTarget,
  NativeMaintenanceToken,
  NativeMaintenanceSnapshot,
} from "./workspace-hierarchy/nativeMaintenanceFence.js";

export type MaintenanceLeaseRequest =
  | { command: "freezeAdmissions" }
  | { command: "releaseAdmissions"; lease: MaintenanceLease };
export type MaintenanceLeaseReply = MaintenanceLease | { released: true };

/** Parses untrusted IPC payloads without exposing Node callbacks or accepting arbitrary commands. */
export function createNodeMaintenanceLeaseHandler(
  port: MaintenanceLeasePort,
): (payload: unknown) => Promise<MaintenanceLeaseReply> {
  return async (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid maintenance lease request");
    const request = payload as Record<string, unknown>;
    if (request.command === "freezeAdmissions" && Object.keys(request).length === 1)
      return port.freezeAdmissions();
    if (
      request.command !== "releaseAdmissions" ||
      Object.keys(request).length !== 2 ||
      !request.lease ||
      typeof request.lease !== "object" ||
      Array.isArray(request.lease)
    )
      throw new Error("Invalid maintenance lease request");
    const lease = request.lease as Record<string, unknown>;
    if (
      Object.keys(lease).length !== 2 ||
      typeof lease.token !== "string" ||
      !lease.token ||
      typeof lease.epoch !== "number" ||
      !Number.isSafeInteger(lease.epoch) ||
      lease.epoch < 1
    )
      throw new Error("Invalid maintenance lease request");
    await port.releaseAdmissions({ token: lease.token, epoch: lease.epoch });
    return { released: true };
  };
}
