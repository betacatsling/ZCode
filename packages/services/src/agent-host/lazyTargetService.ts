import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import type { ProviderRegistryService } from "@zcode/provider";
import { writableSessionSpecV2Schema, type ExecutionTarget, type HarnessManifest } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "./harnessRegistry.js";
import { createRegistryModelCatalog } from "./registryCatalog.js";
import { createRpcAgentHostService } from "./rpcTargetService.js";
import type { IAgentHostService } from "./serviceContract.js";
import { AgentHostTargetService, type TargetHostEvent, type WorkspaceAdmissionPort } from "./targetService.js";

const piManifest: HarnessManifest = { schemaVersion: 1, id: "pi", name: "Pi", adapterVersion: "0.87.1" };

/** Lazy registration avoids loading Pi/CLI model adapters during native-only startup. */
export function createLazyTargetAgentHostService(input: {
  root: string;
  target: ExecutionTarget;
  registry: ProviderRegistryService;
  allowNewSessions: () => boolean;
  admission: WorkspaceAdmissionPort;
}): { service: IAgentHostService; dispose(): Promise<void> } {
  let target: AgentHostTargetService | undefined;
  let flight: Promise<AgentHostTargetService> | undefined;
  let targetDispose: (() => void) | undefined;
  let disposed = false;
  const events = new Emitter<TargetHostEvent>();
  const historyOnly = new AgentHostTargetService({
    root: join(input.root, "sessions"), target: input.target,
    catalog: { fingerprint: "history-only", validateSelection: () => ({ ok: false as const, reason: "history-only" }) },
    registry: new HarnessRegistry(), admission: input.admission,
  });
  const getTarget = async (): Promise<AgentHostTargetService> => {
    if (disposed) throw new Error("agent host service disposed");
    if (target) return target;
    if (!flight) flight = (async () => {
      await input.registry.start();
      const { createRegistryPiHarness } = await import("../agent-adapters/pi/createPiHarness.js");
      const harnesses = new HarnessRegistry();
      harnesses.registerTrusted(piManifest,
        () => createRegistryPiHarness({ root: join(input.root, "workers"), registry: input.registry }));
      const instance = new AgentHostTargetService({
        root: join(input.root, "sessions"), target: input.target,
        catalog: createRegistryModelCatalog(input.registry), registry: harnesses,
        admission: input.admission,
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
      harnesses: [piManifest.id],
      admissionEnabled: input.allowNewSessions() && input.target.available,
    }),
    catalogForTarget: async (targetId) => (await getTarget()).catalogForTarget(targetId),
    getSessionCapabilities: (spec) => (target ?? historyOnly).getSessionCapabilities(spec),
    getRuntimeActivity: (workspaceId) => (target ?? historyOnly).getRuntimeActivity(workspaceId),
    getSessionReadModel: (spec) => (target ?? historyOnly).getSessionReadModel(spec),
    getSessionSpec: (scope) => (target ?? historyOnly).getSessionSpec(scope),
    listWorkspaceSessions: (workspaceId) => (target ?? historyOnly).listWorkspaceSessions(workspaceId),
    rowsRange: (spec, request) => (target ?? historyOnly).rowsRange(spec, request),
    async listSessions(workspaceIdentity, worktreePath) {
      return (target ?? historyOnly).listSessions(workspaceIdentity, worktreePath);
    },
    async create(spec, commandId) {
      if (!input.allowNewSessions()) {
        const prior = await (target ?? historyOnly).queryCreationCommand(commandId);
        if (prior && JSON.stringify(prior.spec) === JSON.stringify(writableSessionSpecV2Schema.parse(spec)) && prior.receipt.status === "completed")
          return (target ?? historyOnly).snapshot(prior.spec);
        throw new Error("new external sessions disabled; existing history remains readable");
      }
      return (await getTarget()).create(spec, commandId);
    },
    queryCreationCommand: (commandId) => (target ?? historyOnly).queryCreationCommand(commandId),
    async attach(spec) { return (await getTarget()).attach(spec); },
    async dispatch(spec, command) {
      // 控制已接受的轮次不应仅因调用而懒启动 Pi；冷 Host 不持有 epoch，必须显式 attach。
      if (command.type === "cancelTurn" || command.type === "detach" || command.type === "viewHistory" ||
          command.type === "terminateSession" || (command.type === "resolveInteraction" && command.decision === "deny"))
        return (target ?? historyOnly).dispatch(spec, command);
      // 已挂载 Host 的已接受 ID 可在关停新 admission 后取得重复回执；不为冷历史启动 worker。
      if (target && await target.queryCommand(spec, command.commandId)) return target.dispatch(spec, command);
      if (!input.allowNewSessions()) throw new Error("new external execution disabled; existing history remains readable");
      return (await getTarget()).dispatch(spec, command);
    },
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
