import { Emitter } from "@zcode/rpc";
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
    listSessions: (workspaceIdentity, worktreePath) => target.listSessions(workspaceIdentity, worktreePath),
    create: (spec) => target.create(spec),
    attach: (spec) => target.attach(spec),
    dispatch: (spec, command) => target.dispatch(spec, command),
    snapshot: (spec) => target.snapshot(spec),
    eventsSince: (spec, sequence) => target.eventsSince(spec, sequence),
    queryCommand: (spec, commandId) => target.queryCommand(spec, commandId),
  };
  return { service, dispose: () => { unsubscribe(); emitter.dispose(); } };
}
