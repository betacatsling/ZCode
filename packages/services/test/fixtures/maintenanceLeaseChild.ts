import {
  createMaintenanceCoordination,
  createNodeMaintenanceLeaseHandler,
} from "../../src/maintenance-lease.js";

let finish!: () => void;
const port = createMaintenanceCoordination({
  nativeFence: async () => ({ verify: async () => true, release: async () => {} }),
  activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
});
const handle = createNodeMaintenanceLeaseHandler(port);
process.on("message", (message: unknown) => {
  if (!message || typeof message !== "object" || !("id" in message) || !("request" in message))
    return;
  const { id, request } = message as { id: number; request: unknown };
  void (async () => {
    try {
      if (request === "test:admit") {
        void port.withAdmission(async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        });
        process.send?.({ id, result: "accepted" });
        return;
      }
      if (request === "test:finish") {
        finish();
        process.send?.({ id, result: "finished" });
        return;
      }
      process.send?.({ id, result: await handle(request) });
    } catch (error) {
      process.send?.({ id, error: error instanceof Error ? error.message : String(error) });
    }
  })();
});
