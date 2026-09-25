import { join } from "node:path";
import { ServiceCollection } from "@zcode/services";
import {
  disposeServiceResourcesAndWait,
  getAppConfigDir,
  ProfileFileOwner,
} from "@zcode/services/node";
import { runServerCore } from "./core.js";

// 只持有真实 core-authority profile 锁的最小 authority：用于验证 Supervisor 对
// stale owner lock 的恢复，不加载完整服务集合（重型服务由独立 fixture 覆盖）。
const generation = Number(process.argv[2] ?? 0);
let owner: ProfileFileOwner | undefined;
void runServerCore(generation, async () => {
  owner = await ProfileFileOwner.open(join(getAppConfigDir(), "core-authority.json"));
  process.send?.({ type: "lock-acquired", pid: process.pid });
  const services = new ServiceCollection();
  return {
    services,
    async dispose() {
      await owner?.close().catch(() => undefined);
      await disposeServiceResourcesAndWait(services);
    },
    async reconcileBeforeAdmission() {},
    maintenance: {
      async freezeAdmissions() {
        return {
          async release() {},
        };
      },
      async readActivity() {
        return {
          native: { running: 0, waiting: 0, uncertain: 0 },
          external: { running: 0, waiting: 0, uncertain: 0 },
        };
      },
    },
  };
}).catch((error: unknown) => {
  process.send?.({ type: "fatal", message: String(error) }, () => process.exit(1));
});
