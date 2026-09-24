import { isAbsolute, join } from "node:path";
import { Emitter } from "@zcode/rpc";
import type { ProviderRegistryService } from "@zcode/provider";
import type { ExecutionTarget } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "./harnessRegistry.js";
import { createRegistryModelCatalog } from "./registryCatalog.js";
import { createRpcAgentHostService } from "./rpcTargetService.js";
import type { IAgentHostService } from "./serviceContract.js";
import { AgentHostTargetService, type TargetHostEvent } from "./targetService.js";

/** Lazy registration avoids loading Pi/CLI model adapters during native-only startup. */
export function createLazyTargetAgentHostService(input: {
  root: string;
  target: ExecutionTarget;
  registry: ProviderRegistryService;
  allowNewSessions: () => boolean;
}): { service: IAgentHostService; dispose(): Promise<void> } {
  let target: AgentHostTargetService | undefined;
  let flight: Promise<AgentHostTargetService> | undefined;
  let targetDispose: (() => void) | undefined;
  let disposed = false;
  const events = new Emitter<TargetHostEvent>();
  const authorizeWorktree = async (spec: { execution: { worktreePath: string } }, realPath: string) =>
    isAbsolute(spec.execution.worktreePath) && isAbsolute(realPath);
  const historyOnly = new AgentHostTargetService({
    root: join(input.root, "sessions"), target: input.target,
    catalog: { fingerprint: "history-only", validateSelection: () => ({ ok: false as const, reason: "history-only" }) },
    registry: new HarnessRegistry(), authorizeWorktree,
  });
  const getTarget = async (): Promise<AgentHostTargetService> => {
    if (disposed) throw new Error("agent host service disposed");
    if (target) return target;
    if (!flight) flight = (async () => {
      await input.registry.start();
      const { createRegistryPiHarness } = await import("../agent-adapters/pi/createPiHarness.js");
      const harnesses = new HarnessRegistry();
      harnesses.register(createRegistryPiHarness({ root: join(input.root, "workers"), registry: input.registry }));
      const instance = new AgentHostTargetService({
        root: join(input.root, "sessions"), target: input.target,
        catalog: createRegistryModelCatalog(input.registry), registry: harnesses,
        // Trusted target channel only; reject symlink aliases in this environment.
        authorizeWorktree,
      });
      const rpc = createRpcAgentHostService(instance, input.allowNewSessions);
      const unsubscribe = rpc.service.onEvent((event) => events.fire(event));
      targetDispose = () => { unsubscribe.dispose(); rpc.dispose(); };
      target = instance;
      return instance;
    })().catch((error: unknown) => { flight = undefined; throw error; });
    return flight;
  };
  const service: IAgentHostService = {
    onEvent: events.event,
    getAvailability: async () => ({
      target: input.target,
      harnesses: ["pi"],
      admissionEnabled: input.allowNewSessions() && input.target.available,
    }),
    async listSessions(workspaceIdentity, worktreePath) {
      return (target ?? historyOnly).listSessions(workspaceIdentity, worktreePath);
    },
    async create(spec) {
      if (!input.allowNewSessions()) throw new Error("new external sessions disabled; existing history remains readable");
      return (await getTarget()).create(spec);
    },
    async attach(spec) { return (await getTarget()).attach(spec); },
    async dispatch(spec, command) { return (await getTarget()).dispatch(spec, command); },
    async snapshot(spec) { return (target ?? historyOnly).snapshot(spec); },
    async eventsSince(spec, sequence) { return (target ?? historyOnly).eventsSince(spec, sequence); },
    async queryCommand(spec, commandId) { return (target ?? historyOnly).queryCommand(spec, commandId); },
  };
  return {
    service,
    async dispose() {
      disposed = true;
      targetDispose?.();
      events.dispose();
      // Process shutdown with an active turn leaves durable accepted/unknown; no
      // fabricated completion or implicit prompt replay on the next target epoch.
      if (target) await target.close();
      await historyOnly.close();
    },
  };
}
