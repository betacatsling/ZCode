import { IAgentHostService, ServiceCollection } from "@zcode/services";
import { createMockAgentHostRuntime } from "@zcode/services/agent-host/mock-runtime-test";
import { runServerCore } from "../core.js";

const generation = Number(process.argv[2] ?? 0);
const root = process.env.ZCODE_TEST_AGENT_HOST_ROOT;
const worktreePath = process.env.ZCODE_TEST_WORKTREE;
const targetId = process.env.ZCODE_TEST_TARGET_ID ?? "target-integration";
if (!root || !worktreePath) throw new Error("missing mock Core integration roots");

let runtime: ReturnType<typeof createMockAgentHostRuntime> | undefined;
void runServerCore(generation, {
  createServices: (options) => {
    runtime = createMockAgentHostRuntime({
      root,
      targetId: options.agentHostTargetId ?? targetId,
      worktreePath,
    });
    return new ServiceCollection().register(IAgentHostService, runtime.service);
  },
  disposeServices: async () => {
    await runtime?.dispose();
  },
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (typeof process.send !== "function" || process.connected === false) {
    process.exit(1);
  }
  try {
    process.send({ type: "fatal", message }, () => process.exit(1));
  } catch {
    process.exit(1);
  }
});
