import {
  writableSessionSpecV2Schema,
  type AgentCommand,
  type AgentCommandReceipt,
  type SessionSpecV2,
} from "@zcode/shared/agent-host";
import {
  commandPayloadSchemas,
  type CommandAck,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "./transport.js";
import type {
  AgentHostConversationPort,
  AgentHostConversationScope,
  HostSessionOwner,
} from "./agentHostConversationTransport.js";

export const unsupported = (operation: string): never => {
  throw new Error(`externalHarnessUnsupported: ${operation}`);
};

export function ack(
  receipt: AgentCommandReceipt,
  revisionAtDecision: number,
  result?: CommandAck["result"],
): CommandAck {
  return {
    commandId: receipt.commandId,
    status:
      receipt.status === "accepted" || receipt.status === "completed"
        ? "accepted"
        : receipt.status === "duplicate"
          ? "duplicate"
          : receipt.status === "execution-unknown"
            ? "failed"
            : "rejected",
    // Bug 原因：执行结果未知不是拒绝入队；不能让 UI 误把它当成确定未执行而重发。
    ...(receipt.status === "execution-unknown"
      ? { reasonCode: "execution-unknown" }
      : receipt.reasonCode
        ? { reasonCode: receipt.reasonCode }
        : {}),
    ...(receipt.message ? { message: receipt.message } : {}),
    revisionAtDecision,
    ...(result ? { result } : {}),
  };
}

/** Admission and stale-action guards use the Host snapshot; UI never owns command execution. */
export function createHostSendCommand(
  service: AgentHostConversationPort,
  scope: AgentHostConversationScope,
  resolve: (id: string) => Promise<HostSessionOwner>,
  snapshotFor: (spec: SessionSpecV2) => Promise<ConversationSnapshot>,
): ConversationTransport["sendCommand"] {
  return async (envelope) => {
    if (envelope.type === "createSession" && envelope.sessionId === null) {
      const payload = commandPayloadSchemas.createSession.parse(envelope.payload);
      const metadata = (envelope.payload as { agentHost?: { spec?: unknown } }).agentHost;
      const spec = writableSessionSpecV2Schema.parse(metadata?.spec);
      if (
        spec.execution.targetId !== scope.targetId ||
        spec.workspaceId !== scope.workspaceId ||
        spec.execution.workspaceIdentity !== scope.workspaceIdentity ||
        spec.execution.worktreePath !== scope.worktreePath ||
        spec.harness.id === "zcode" ||
        payload.firstInput ||
        payload.config ||
        payload.mcpServers?.length ||
        payload.offPeakToolEnabled ||
        payload.dynamicWorkflowEnabled
      )
        return unsupported("createSession payload or target");
      const snapshot = await service.create(spec, envelope.commandId);
      if (
        snapshot.sessionId !== spec.hostSessionId ||
        snapshot.agentHost?.hostSessionId !== spec.hostSessionId ||
        snapshot.agentHost?.targetId !== scope.targetId ||
        snapshot.agentHost?.harnessId !== spec.harness.id
      ) {
        throw new Error("external create owner mismatch");
      }
      return ack({ commandId: envelope.commandId, status: "accepted" }, snapshot.revision, {
        type: "createSession",
        sessionId: spec.hostSessionId,
      });
    }
    if (!envelope.sessionId) return unsupported(envelope.type);
    const owner = await resolve(envelope.sessionId);
    if (owner.spec.schemaVersion !== 2 || owner.historyOnly)
      return unsupported("legacy history is read-only");
    const spec = owner.spec;
    let command: AgentCommand;
    if (envelope.type === "sendText") {
      const payload = commandPayloadSchemas.sendText.parse(envelope.payload);
      if (
        !payload.text.trim() ||
        payload.attachments?.length ||
        payload.requestedDelivery ||
        payload.browserAmbientContext ||
        payload.context_refs?.length ||
        payload.heldQueueDisposition ||
        payload.expectedHeldQueueItemIds?.length ||
        payload.modelExecution ||
        payload.automationId ||
        payload.offPeakTaskId ||
        payload.botDeliveryTarget ||
        payload.toolDisallowlist?.length ||
        payload.modelSelection ||
        payload.mode ||
        payload.planEnabled !== undefined
      ) {
        return unsupported("sendText payload");
      }
      command = {
        type: "send",
        hostSessionId: spec.hostSessionId,
        commandId: envelope.commandId,
        turnId: envelope.commandId,
        text: payload.text,
      };
    } else if (envelope.type === "stop") {
      const payload = commandPayloadSchemas.stop.parse(envelope.payload);
      const snapshot = await snapshotFor(spec);
      const turn = payload.expectedForegroundExecutionId;
      if (
        !turn ||
        snapshot.logEpoch !== envelope.baseLogEpoch ||
        !snapshot.control.activeWorks.some((work) => work.foregroundExecutionId === turn)
      )
        return unsupported("stale stop target");
      command = {
        type: "cancelTurn",
        hostSessionId: spec.hostSessionId,
        commandId: envelope.commandId,
        runtimeEpoch: snapshot.logEpoch,
        turnId: turn,
      };
    } else if (envelope.type === "resolveInteraction") {
      const payload = commandPayloadSchemas.resolveInteraction.parse(envelope.payload);
      const snapshot = await snapshotFor(spec);
      const interaction = snapshot.pendingInteractions.find(
        (item) => item.interactionId === payload.interactionId,
      );
      const turn = snapshot.control.activeWorks.find(
        (work) => work.kind === "primaryTurn",
      )?.foregroundExecutionId;
      if (interaction?.kind === "userInput" && interaction.payload.kind === "userInput") {
        const selected = interaction.payload.options?.find((option) => option.optionId === payload.answer.optionId);
        const answer = selected?.optionId ?? (interaction.payload.freeText ? payload.answer.freeText : undefined);
        if (!turn || snapshot.logEpoch !== envelope.baseLogEpoch || !answer?.trim() || payload.answer.action || payload.answer.content || (payload.answer.optionId && !selected) || (payload.answer.freeText && (!interaction.payload.freeText || !!selected)))
          return unsupported("stale or unsupported question answer");
        command = { type: "answerInteraction", hostSessionId: spec.hostSessionId, commandId: envelope.commandId,
          runtimeEpoch: snapshot.logEpoch, turnId: turn, interactionId: interaction.interactionId, answer };
      } else {
        if (
        !interaction ||
        !turn ||
        snapshot.logEpoch !== envelope.baseLogEpoch ||
        (payload.answer.optionId !== "allow" && payload.answer.optionId !== "deny") ||
        payload.answer.action ||
        payload.answer.content ||
        payload.answer.freeText
      )
        return unsupported("stale or unsupported interaction");
      command = {
        type: "resolveInteraction",
        hostSessionId: spec.hostSessionId,
        commandId: envelope.commandId,
        runtimeEpoch: snapshot.logEpoch,
        turnId: turn,
        interactionId: interaction.interactionId,
          decision: payload.answer.optionId,
        };
      }
    } else return unsupported(envelope.type);
    const receipt = await service.dispatch(spec, command);
    return ack(receipt, envelope.baseRevision ?? 0);
  };
}
