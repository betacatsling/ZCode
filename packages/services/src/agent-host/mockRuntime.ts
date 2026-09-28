import type { ExecutionTarget } from "@zcode/shared/agent-host";
import { createRpcAgentHostService } from "./rpcTargetService.js";
import { AgentHostTargetService } from "./targetService.js";
import { HarnessRegistry } from "./harnessRegistry.js";
import { MockHarness } from "./mockHarness.js";

/** Fixed credential-free Runtime Host fixture for independent-process tests. */
export function createMockAgentHostRuntime(input: {
  root: string;
  targetId: string;
  worktreePath: string;
}): {
  service: ReturnType<typeof createRpcAgentHostService>["service"];
  dispose(): Promise<void>;
} {
  const target: ExecutionTarget = {
    id: input.targetId,
    kind: "local",
    platform: process.platform as "darwin" | "linux",
    available: true,
  };
  const registry = new HarnessRegistry();
  registry.register(new MockHarness({ delayMs: 250 }));
  const host = new AgentHostTargetService({
    root: input.root,
    target,
    registry,
    catalog: {
      fingerprint: "mock-runtime",
      validateSelection: () => ({ ok: true }),
    },
    authorizeWorktree: async (spec, realPath) =>
      spec.execution.worktreePath === input.worktreePath && realPath === input.worktreePath,
  });
  const rpc = createRpcAgentHostService(host, () => true);
  return {
    service: rpc.service,
    async dispose() {
      rpc.dispose();
      await host.close();
    },
  };
}
