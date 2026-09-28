import { Emitter } from "@zcode/rpc";
import type { IAgentHostService } from "./serviceContract.js";
import { createAgentHostConversationBridge } from "./conversationBridge.js";
import { readHarnessStaticAsset } from "./harnessAssets.js";
import { AgentHostTargetService, type TargetHostEvent } from "./targetService.js";

/** Explicit RPC allowlist: do not expose TargetService.close(), subscribe(), or worker internals. */
export function createRpcAgentHostService(
  target: AgentHostTargetService,
  admissionEnabled: () => boolean,
): {
  service: IAgentHostService;
  dispose(): void;
} {
  const emitter = new Emitter<TargetHostEvent>();
  const conversation = createAgentHostConversationBridge(target);
  const unsubscribe = target.subscribe((event) => emitter.fire(event));
  const service: IAgentHostService = {
    onEvent: emitter.event,
    onConversationFrame: conversation.onFrame,
    getAvailability: async () => ({
      ...(await target.getAvailability()),
      admissionEnabled: admissionEnabled(),
    }),
    listSessions: (workspaceIdentity, worktreePath) =>
      target.listSessions(workspaceIdentity, worktreePath),
    getDirectory: async () => {
      const directory = await target.getDirectory();
      return {
        schemaVersion: 1 as const,
        targetId: (await target.getAvailability()).target.id,
        status: "available" as const,
        entries: [...directory.list()],
      };
    },
    getHarnessAsset: async (assetId) => readHarnessStaticAsset(assetId),
    listSessionSummaries: (workspaceIdentity, worktreePath) =>
      target.listSessionSummaries(workspaceIdentity, worktreePath),
    listActivityIndex: () => target.listActivityIndex(),
    create: (spec) => target.create(spec),
    attach: (spec) => target.attach(spec),
    dispatch: (spec, command) => target.dispatch(spec, command),
    snapshot: (spec) => target.snapshot(spec),
    eventsSince: (spec, sequence) => target.eventsSince(spec, sequence),
    queryCommand: (spec, commandId) => target.queryCommand(spec, commandId),
    createExternalSession: (request) => conversation.createExternalSession(request),
    createExternalForWorkspace: (request) => target.createExternalForWorkspace(request),
    createWorkspaceSession: (request) => target.createWorkspaceSession(request),
    getWorkspaceSessionCapability: (request) =>
      target.getWorkspaceSessionCapability(request),
    listWorkspaceSessionOwners: (request) => target.listWorkspaceSessionOwners(request),
    subscribeConversation: (request) => conversation.subscribeConversation(request),
    resyncConversation: (request) => conversation.resyncConversation(request),
    unsubscribeConversation: (request) => conversation.unsubscribeConversation(request),
    conversationRowsRange: (request) => conversation.conversationRowsRange(request),
  };
  return {
    service,
    dispose: () => {
      unsubscribe();
      conversation.dispose();
      emitter.dispose();
    },
  };
}
