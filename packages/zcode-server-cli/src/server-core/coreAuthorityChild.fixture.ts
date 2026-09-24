import { ServiceCollection } from "@zcode/services";
import { runServerCore } from "./core.js";
import { disposeServiceResourcesAndWait } from "@zcode/services/node";

let frozen = false;
let waiting = 0;
const generation = Number(process.argv[2] ?? 0);
void runServerCore(generation, async (options) => {
  process.send?.({ type: "factory-options", options });
  const services = new ServiceCollection();
  return {
    services,
    async dispose() {
      await disposeServiceResourcesAndWait(services);
    },
    async reconcileBeforeAdmission() {
      process.send?.({ type: "reconciled" });
    },
    maintenance: {
      async freezeAdmissions() {
        if (frozen) throw new Error("already frozen");
        frozen = true;
        return {
          async release() {
            frozen = false;
          },
        };
      },
      async readActivity() {
        return {
          native: { running: 0, waiting, uncertain: 0 },
          external: { running: 0, waiting: 0, uncertain: 0 },
        };
      },
    },
  };
}).catch((error: unknown) => {
  process.send?.({ type: "fatal-fixture", error: String(error) }, () => process.exit(1));
});
process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const command = raw as { command?: string };
  if (command.command === "fixture-wait") waiting = 1;
  if (command.command === "fixture-finish") waiting = 0;
  if (command.command === "fixture-admit")
    process.send?.({ type: "fixture-admitted", accepted: !frozen });
});
