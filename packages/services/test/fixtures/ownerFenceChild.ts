import { reserveOwnerLease } from "../../src/agent-host/runtime/ownerFence.js";

const [root, targetId, hostSessionId, generation] = process.argv.slice(2);
if (!root || !targetId || !hostSessionId || !generation) {
  throw new Error("owner fence child arguments missing");
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      resolve();
      return;
    }
    process.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

try {
  await reserveOwnerLease({
    root,
    targetId,
    hostSessionId,
    generation: Number(generation),
    ownerToken: "child-owner",
  });
  await send({ status: "acquired" });
  // 持有 lease 直到父进程 SIGKILL；自行退出会让 pid 提前变死，测不到活 owner。
  await new Promise<void>(() => undefined);
} catch (error) {
  await send({
    status: "blocked",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exit(0);
}
