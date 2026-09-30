import type { AgentCommand, CompatibleSessionSpec } from "@zcode/shared/agent-host";
import { agentCommandSchema } from "@zcode/shared/agent-host";
import {
  commandAckSchema,
  parseCommandEnvelope,
  type CommandAck,
  type CommandPayloadMap,
  type ConversationRow,
  type PendingInteraction,
} from "@zcode/shared/zcode-protocol-v4";

const UNAVAILABLE = "externalHarnessUnsupported";

export type TranslateV4CommandResult =
  | { kind: "command"; command: AgentCommand }
  | { kind: "rejected"; ack: CommandAck };

/**
 * 把 V4 命令译成宿主命令。高级字段不能丢掉之后降级执行；整单拒绝并标成不可用。
 * 翻译器不保存命令队列，幂等由 Host 的 commandId 负责。
 */
export function translateV4Command(input: {
  envelope: unknown;
  spec: CompatibleSessionSpec;
  runtimeEpoch: string;
  revision: number;
  nextTurnId?: string;
  rows?: readonly ConversationRow[];
  pendingInteractions?: readonly PendingInteraction[];
}): TranslateV4CommandResult {
  const parsed = parseCommandEnvelope(input.envelope);
  if (!parsed.ok) {
    return reject(
      commandIdOf(input.envelope),
      input.revision,
      "invalid-command",
      parsed.error.message,
    );
  }
  const envelope = parsed.envelope;
  if (envelope.sessionId !== null && envelope.sessionId !== input.spec.hostSessionId) {
    return reject(
      envelope.commandId,
      input.revision,
      "session-mismatch",
      "sessionId does not match host session",
    );
  }
  switch (envelope.type) {
    case "createSession":
      return translateCreate(
        envelope.commandId,
        input,
        envelope.payload as CommandPayloadMap["createSession"],
        envelope.managedWorkspaceSession,
      );
    case "sendText":
      return translateSend(
        envelope.commandId,
        input,
        envelope.payload as CommandPayloadMap["sendText"],
      );
    case "stop":
      return translateStop(
        envelope.commandId,
        input,
        envelope.payload as CommandPayloadMap["stop"],
      );
    case "resolveInteraction":
      return translateInteraction(
        envelope.commandId,
        input,
        envelope.payload as CommandPayloadMap["resolveInteraction"],
      );
    default:
      return reject(
        envelope.commandId,
        input.revision,
        UNAVAILABLE,
        `unsupported command: ${envelope.type}`,
      );
  }
}

function translateCreate(
  commandId: string,
  input: { spec: CompatibleSessionSpec; revision: number },
  payload: {
    firstInput?: unknown;
    config?: unknown;
    mcpServers?: readonly unknown[];
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
  },
  managedWorkspaceSession: unknown,
): TranslateV4CommandResult {
  const blocked = blockedCreateField(payload, managedWorkspaceSession);
  if (blocked) {
    return reject(commandId, input.revision, UNAVAILABLE, `unsupported field: ${blocked}`);
  }
  return accept({ type: "createSession", commandId, hostSessionId: input.spec.hostSessionId });
}

function translateSend(
  commandId: string,
  input: { spec: CompatibleSessionSpec; revision: number; nextTurnId?: string },
  payload: {
    text: string;
    attachments?: readonly unknown[];
    requestedDelivery?: string;
    browserAmbientContext?: unknown;
    context_refs?: readonly unknown[];
    heldQueueDisposition?: unknown;
    expectedHeldQueueItemIds?: readonly unknown[];
    modelSelection?: unknown;
    mode?: unknown;
    planEnabled?: unknown;
    modelExecution?: unknown;
    automationId?: unknown;
    offPeakTaskId?: unknown;
    offPeakRunType?: unknown;
    botDeliveryTarget?: unknown;
    toolDisallowlist?: readonly unknown[];
  },
): TranslateV4CommandResult {
  const blocked = blockedSendField(payload);
  if (blocked)
    return reject(commandId, input.revision, UNAVAILABLE, `unsupported field: ${blocked}`);
  if (!input.nextTurnId) {
    return reject(commandId, input.revision, UNAVAILABLE, "unsupported field: turnId");
  }
  return accept({
    type: "send",
    commandId,
    hostSessionId: input.spec.hostSessionId,
    turnId: input.nextTurnId,
    text: payload.text,
  });
}

function translateStop(
  commandId: string,
  input: { spec: CompatibleSessionSpec; runtimeEpoch: string; revision: number },
  payload: { expectedForegroundExecutionId?: string },
): TranslateV4CommandResult {
  const turnId = payload.expectedForegroundExecutionId;
  if (!turnId) {
    return reject(
      commandId,
      input.revision,
      "stale-turn",
      "stop requires expectedForegroundExecutionId",
    );
  }
  return accept({
    type: "cancelTurn",
    commandId,
    hostSessionId: input.spec.hostSessionId,
    runtimeEpoch: input.runtimeEpoch,
    turnId,
  });
}

function translateInteraction(
  commandId: string,
  input: {
    spec: CompatibleSessionSpec;
    runtimeEpoch: string;
    revision: number;
    rows?: readonly ConversationRow[];
    pendingInteractions?: readonly PendingInteraction[];
  },
  payload: {
    interactionId: string;
    answer: {
      optionId?: string;
      freeText?: string;
      action?: unknown;
      content?: unknown;
    };
  },
): TranslateV4CommandResult {
  if (payload.answer.action !== undefined || payload.answer.content !== undefined) {
    return reject(commandId, input.revision, UNAVAILABLE, "unsupported field: answer");
  }
  const optionId = payload.answer.optionId;
  if (optionId !== "allow" && optionId !== "deny") {
    return reject(commandId, input.revision, UNAVAILABLE, "unsupported field: optionId");
  }
  const pending = input.pendingInteractions?.find(
    (item) => item.interactionId === payload.interactionId,
  );
  const anchorId = pending?.anchorRowId;
  const row = anchorId == null ? undefined : input.rows?.find((item) => item.rowId === anchorId);
  if (!pending || !row) {
    return reject(commandId, input.revision, "stale-interaction", "interaction is not pending");
  }
  return accept({
    type: "resolveInteraction",
    commandId,
    hostSessionId: input.spec.hostSessionId,
    runtimeEpoch: input.runtimeEpoch,
    turnId: row.turnId,
    interactionId: payload.interactionId,
    decision: optionId,
    ...(payload.answer.freeText !== undefined ? { answer: payload.answer.freeText } : {}),
  });
}

function blockedCreateField(
  payload: {
    firstInput?: unknown;
    config?: unknown;
    mcpServers?: readonly unknown[];
    offPeakToolEnabled?: boolean;
    dynamicWorkflowEnabled?: boolean;
  },
  managedWorkspaceSession: unknown,
): string | null {
  if (payload.firstInput !== undefined) return "firstInput";
  if (payload.config !== undefined) return "config";
  if (payload.mcpServers && payload.mcpServers.length > 0) return "mcpServers";
  if (payload.offPeakToolEnabled !== undefined) return "offPeakToolEnabled";
  if (payload.dynamicWorkflowEnabled !== undefined) return "dynamicWorkflowEnabled";
  if (managedWorkspaceSession !== undefined) return "managedWorkspaceSession";
  return null;
}

function blockedSendField(payload: {
  attachments?: readonly unknown[];
  requestedDelivery?: string;
  browserAmbientContext?: unknown;
  context_refs?: readonly unknown[];
  heldQueueDisposition?: unknown;
  expectedHeldQueueItemIds?: readonly unknown[];
  modelSelection?: unknown;
  mode?: unknown;
  planEnabled?: unknown;
  modelExecution?: unknown;
  automationId?: unknown;
  offPeakTaskId?: unknown;
  offPeakRunType?: unknown;
  botDeliveryTarget?: unknown;
  toolDisallowlist?: readonly unknown[];
}): string | null {
  if (payload.attachments && payload.attachments.length > 0) return "attachments";
  if (payload.requestedDelivery !== undefined && payload.requestedDelivery !== "startNow") {
    return "requestedDelivery";
  }
  if (payload.browserAmbientContext !== undefined) return "browserAmbientContext";
  if (payload.context_refs && payload.context_refs.length > 0) return "context_refs";
  if (payload.heldQueueDisposition !== undefined) return "heldQueueDisposition";
  if (payload.expectedHeldQueueItemIds && payload.expectedHeldQueueItemIds.length > 0) {
    return "expectedHeldQueueItemIds";
  }
  if (payload.modelSelection !== undefined) return "modelSelection";
  if (payload.mode !== undefined) return "mode";
  if (payload.planEnabled !== undefined) return "planEnabled";
  if (payload.modelExecution !== undefined) return "modelExecution";
  if (payload.automationId !== undefined) return "automationId";
  if (payload.offPeakTaskId !== undefined) return "offPeakTaskId";
  if (payload.offPeakRunType !== undefined) return "offPeakRunType";
  if (payload.botDeliveryTarget !== undefined) return "botDeliveryTarget";
  if (payload.toolDisallowlist && payload.toolDisallowlist.length > 0) return "toolDisallowlist";
  return null;
}

function accept(command: AgentCommand): TranslateV4CommandResult {
  return { kind: "command", command: agentCommandSchema.parse(command) };
}

function reject(
  commandId: string,
  revision: number,
  reasonCode: string,
  message: string,
): TranslateV4CommandResult {
  return {
    kind: "rejected",
    ack: commandAckSchema.parse({
      commandId,
      status: "rejected",
      reasonCode,
      message: message.slice(0, 1024),
      revisionAtDecision: revision,
    }),
  };
}

function commandIdOf(value: unknown): string {
  if (typeof value === "object" && value !== null && "commandId" in value) {
    const commandId = value.commandId;
    if (typeof commandId === "string" && commandId.length > 0) return commandId;
  }
  return "invalid";
}
