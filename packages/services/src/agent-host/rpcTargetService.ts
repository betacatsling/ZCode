import { Emitter } from "@zcode/rpc";
import { writableSessionSpecV2Schema } from "@zcode/shared/agent-host";
import type { IAgentHostService } from "./serviceContract.js";
import { AgentHostTargetService, type TargetHostEvent } from "./targetService.js";

/** Explicit RPC allowlist: do not expose TargetService.close(), subscribe(), or worker internals. */
export function createRpcAgentHostService(target: AgentHostTargetService, admissionEnabled: () => boolean): {
  service: IAgentHostService;
  dispose(): void;
} {
  const emitter = new Emitter<TargetHostEvent>();
  const unsubscribe = target.subscribe((event) => emitter.fire(event));
  const service: IAgentHostService = {
    onEvent: emitter.event,
    getAvailability: async () => ({ ...await target.getAvailability(), admissionEnabled: admissionEnabled() }),
    catalogForTarget: (targetId) => target.catalogForTarget(targetId),
    getSessionCapabilities: (spec) => target.getSessionCapabilities(spec),
    getRuntimeActivity: (workspaceId) => target.getRuntimeActivity(workspaceId),
    getSessionSpec: (scope) => target.getSessionSpec(scope),
    listWorkspaceSessions: (workspaceId) => target.listWorkspaceSessions(workspaceId),
    rowsRange: (spec, request) => target.rowsRange(spec, request),
    listSessions: (workspaceIdentity, worktreePath) => target.listSessions(workspaceIdentity, worktreePath),
    create: async (spec, commandId) => {
      if (!admissionEnabled()) {
        const prior = await target.queryCreationCommand(commandId);
        if (prior && JSON.stringify(prior.spec) === JSON.stringify(writableSessionSpecV2Schema.parse(spec)) && prior.receipt.status === "completed") return target.snapshot(prior.spec);
        throw new Error("new external sessions disabled; existing history remains readable");
      }
      return target.create(spec, commandId);
    },
    queryCreationCommand: (commandId) => target.queryCreationCommand(commandId),
    attach: (spec) => target.attach(spec),
    dispatch: (spec, command) => target.dispatch(spec, command),
    snapshot: (spec) => target.snapshot(spec),
    eventsSince: (spec, sequence) => target.eventsSince(spec, sequence),
    queryCommand: (spec, commandId) => target.queryCommand(spec, commandId),
  };
  return { service, dispose: () => { unsubscribe(); emitter.dispose(); } };
}
