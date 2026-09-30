import type { IAgentHostService } from "@zcode/services";
import {
  agentCommandReceiptSchema,
  agentCommandSchema,
  type AgentCommand,
  type AgentCommandReceipt,
  type AgentHostConversationRuntimePolicy,
  type ExternalSessionCreateRequest,
  type ExternalSessionCreateResult,
} from "@zcode/shared/agent-host";
import {
  commandPayloadSchemas,
  parseCommandEnvelope,
  conversationTopic,
  type CommandAck,
  type CommandEnvelope,
  type CommandsQueryParams,
  type CommandsQueryResult,
  type ConversationTopicFrame,
  type ConversationResyncParams,
  type TopicFrameDeliveryKind,
  type V4ConversationRowsRangeParams,
  type V4ConversationRowsRangeResult,
  TopicWireFrameAssembler,
} from "@zcode/shared/zcode-protocol-v4";
import type { ConversationTransport } from "./transport.js";
import { createAckActivationBarrier } from "./ackActivationBarrier.js";
import { createTopicWireDecoder } from "./topicWireDecoder.js";
import {
  conversationTopicFrameSchema,
  type ConversationTopicWireCandidate,
} from "@zcode/shared/zcode-protocol-v4";

type AgentHostConversationClient = Pick<
  IAgentHostService,
  | "onConversationFrame"
  | "createExternalSession"
  | "subscribeConversation"
  | "resyncConversation"
  | "unsubscribeConversation"
  | "conversationRowsRange"
  | "dispatch"
  | "snapshot"
  | "queryCommand"
>;

export interface AgentHostConversationTransportOptions {
  spec: ExternalSessionCreateRequest["spec"];
  clientMode: "desktop-continuous" | "web-remote-replayable";
  /** Delivery profile and worker admission are independent. Read-only opens stay cold by default. */
  runtimePolicy?: AgentHostConversationRuntimePolicy;
}

export interface AgentHostConversationTransport extends ConversationTransport {
  dispose(): void;
}

function unsupported(name: string): Promise<never> {
  return Promise.reject(new Error(`externalHarnessUnsupported:${name}`));
}

function receiptStatus(receipt: AgentCommandReceipt): CommandAck["status"] {
  switch (receipt.status) {
    case "accepted":
    case "completed":
      return "accepted";
    case "duplicate":
      return "duplicate";
    case "execution-unknown":
      return "failed";
    case "rejected":
      return receipt.reasonCode === "stale-turn" || receipt.reasonCode === "stale-interaction"
        ? "stale"
        : "rejected";
  }
}

async function toCommandAck(
  client: AgentHostConversationClient,
  spec: AgentHostConversationTransportOptions["spec"],
  receipt: AgentCommandReceipt,
): Promise<CommandAck> {
  const snapshot = await client.snapshot(spec);
  return {
    commandId: receipt.commandId,
    status: receiptStatus(receipt),
    ...(receipt.reasonCode ? { reasonCode: receipt.reasonCode } : {}),
    ...(receipt.message ? { message: receipt.message } : {}),
    revisionAtDecision: snapshot.revision,
    // Key-free typed cause (provider-reconfigure-required); absent for older hosts.
    ...(receipt.failure ? { failure: receipt.failure } : {}),
  };
}

function currentTurn(
  snapshot: Awaited<ReturnType<AgentHostConversationClient["snapshot"]>>,
): string {
  const turnId = snapshot.control.activeWorks[0]?.foregroundExecutionId;
  if (!turnId) throw new Error("externalHarnessUnsupported:no-active-turn");
  return turnId;
}

export function createAgentHostConversationTransport(
  client: AgentHostConversationClient,
  options: AgentHostConversationTransportOptions,
): AgentHostConversationTransport {
  const topic = conversationTopic(options.spec.hostSessionId);
  const runtimePolicy = options.runtimePolicy ?? "existing-only";
  const listeners = new Set<
    (frame: ConversationTopicFrame, context?: { deliveryKind: TopicFrameDeliveryKind }) => void
  >();
  const faultListeners = new Set<
    (fault: {
      topic: string;
      subscriptionId: string;
      reasonCode?: string;
      deliveryKind?: TopicFrameDeliveryKind;
    }) => void
  >();
  let decoder: ReturnType<typeof createTopicWireDecoder>;
  const barrier = createAckActivationBarrier<ConversationTopicWireCandidate>((wire) => {
    decoder.accept(wire);
  });
  const subscriptionTopics = new Map<string, string>();
  let upstream: { dispose(): void } | undefined;
  const ensureUpstream = (): void => {
    upstream ??= client.onConversationFrame((wire) => barrier.accept(wire));
  };
  decoder = createTopicWireDecoder(
    new TopicWireFrameAssembler(conversationTopicFrameSchema),
    (frame, deliveryKind) => {
      for (const listener of listeners) listener(frame, { deliveryKind });
    },
    (fault) => {
      for (const listener of faultListeners) listener(fault);
    },
  );

  const dispatchCommand = async (envelope: CommandEnvelope): Promise<CommandAck> => {
    if (envelope.sessionId !== options.spec.hostSessionId) {
      throw new Error("externalHarnessUnsupported:foreign-session");
    }
    const parsed = parseCommandEnvelope(envelope);
    if (!parsed.ok) throw new Error("invalid external command payload");
    let command: AgentCommand;
    switch (parsed.envelope.type) {
      case "sendText": {
        const payload = commandPayloadSchemas.sendText.parse(parsed.envelope.payload);
        const unsupportedKeys = Object.keys(payload).filter(
          (key) => !["text", "modelSelection", "requestedDelivery"].includes(key),
        );
        if (
          unsupportedKeys.length ||
          (payload.requestedDelivery && payload.requestedDelivery !== "startNow")
        ) {
          throw new Error("externalHarnessUnsupported:sendText-options");
        }
        if (
          payload.modelSelection &&
          (options.spec.modelBinding.kind !== "host-managed" ||
            JSON.stringify(payload.modelSelection) !==
              JSON.stringify(options.spec.modelBinding.selection))
        ) {
          throw new Error("externalHarnessUnsupported:model-binding-change");
        }
        command = {
          type: "send",
          commandId: parsed.envelope.commandId,
          hostSessionId: options.spec.hostSessionId,
          turnId: parsed.envelope.commandId,
          text: payload.text,
        };
        break;
      }
      case "stop": {
        const payload = commandPayloadSchemas.stop.parse(parsed.envelope.payload);
        if (!payload.expectedForegroundExecutionId || !parsed.envelope.baseLogEpoch) {
          throw new Error("externalHarnessUnsupported:stale-stop-without-epoch");
        }
        command = {
          type: "cancelTurn",
          commandId: parsed.envelope.commandId,
          hostSessionId: options.spec.hostSessionId,
          runtimeEpoch: parsed.envelope.baseLogEpoch,
          turnId: payload.expectedForegroundExecutionId,
        };
        break;
      }
      case "resolveInteraction": {
        const payload = commandPayloadSchemas.resolveInteraction.parse(parsed.envelope.payload);
        if (!parsed.envelope.baseLogEpoch) {
          throw new Error("externalHarnessUnsupported:stale-interaction-without-epoch");
        }
        const snapshot = await client.snapshot(options.spec);
        const interaction = snapshot.pendingInteractions.find(
          (item) => item.interactionId === payload.interactionId,
        );
        if (!interaction) {
          throw new Error("externalHarnessUnsupported:stale-interaction");
        }
        const actionDecision =
          payload.answer.action === "accept"
            ? "allow"
            : payload.answer.action === "decline" || payload.answer.action === "cancel"
              ? "deny"
              : null;
        let optionDecision: "allow" | "deny" | null = null;
        if (payload.answer.optionId !== undefined) {
          const option =
            interaction.payload.kind === "permission"
              ? interaction.payload.options.find(
                  (candidate) => candidate.optionId === payload.answer.optionId,
                )
              : undefined;
          if (!option) throw new Error("externalHarnessUnsupported:interaction-option");
          optionDecision =
            option.kind === "deny" || option.response?.decision === "deny"
              ? "deny"
              : option.kind === "allowOnce" ||
                  option.kind === "allowAlways" ||
                  option.response?.decision === "allow"
                ? "allow"
                : null;
          if (!optionDecision) throw new Error("externalHarnessUnsupported:interaction-option");
        }
        if (actionDecision && optionDecision && actionDecision !== optionDecision) {
          throw new Error("externalHarnessUnsupported:interaction-answer-conflict");
        }
        const decision = actionDecision ?? optionDecision;
        if (!decision) throw new Error("externalHarnessUnsupported:interaction-answer");
        command = {
          type: "resolveInteraction",
          commandId: parsed.envelope.commandId,
          hostSessionId: options.spec.hostSessionId,
          runtimeEpoch: parsed.envelope.baseLogEpoch,
          turnId: currentTurn(snapshot),
          interactionId: payload.interactionId,
          decision,
        };
        break;
      }
      default:
        throw new Error(`externalHarnessUnsupported:${parsed.envelope.type}`);
    }
    const receipt = agentCommandReceiptSchema.parse(
      await client.dispatch(options.spec, agentCommandSchema.parse(command)),
    );
    return toCommandAck(client, options.spec, receipt);
  };

  return {
    async subscribe(params) {
      if (params.topic !== topic) throw new Error("externalHarnessUnsupported:topic");
      ensureUpstream();
      const pending = barrier.begin(topic);
      try {
        const result = await client.subscribeConversation({
          spec: options.spec,
          topic,
          clientMode: options.clientMode,
          runtimePolicy,
          ...(params.base ? { base: params.base } : {}),
          ...(params.visibility ? { visibility: params.visibility } : {}),
        });
        barrier.bind(pending, result.ack.subscriptionId);
        subscriptionTopics.set(result.ack.subscriptionId, topic);
        return result;
      } catch (error) {
        barrier.cancel(pending);
        throw error;
      }
    },
    activate(subscriptionId) {
      const activation = barrier.activate(subscriptionId);
      if (activation?.previousSubscriptionId) {
        decoder.discard(activation.topic, activation.previousSubscriptionId);
        subscriptionTopics.delete(activation.previousSubscriptionId);
      }
    },
    async resync(params: ConversationResyncParams) {
      if (!subscriptionTopics.has(params.subscriptionId))
        throw new Error("fault.subscription.notOwned");
      decoder.recover(topic, params.subscriptionId);
      return client.resyncConversation({ spec: options.spec, ...params });
    },
    async unsubscribe(subscriptionId) {
      const subscriptionTopic = subscriptionTopics.get(subscriptionId);
      barrier.forget(subscriptionId);
      subscriptionTopics.delete(subscriptionId);
      if (subscriptionTopic) decoder.discard(subscriptionTopic, subscriptionId);
      await client.unsubscribeConversation({ spec: options.spec, subscriptionId });
    },
    sendCommand: dispatchCommand,
    async queryCommands(params: CommandsQueryParams): Promise<CommandsQueryResult> {
      const results = await Promise.all(
        params.commands.map(async (key) => {
          if (key.sessionId !== null && key.sessionId !== options.spec.hostSessionId) {
            return { key, result: "unknown" as const };
          }
          const receipt = await client.queryCommand(options.spec, key.commandId);
          if (!receipt) return { key, result: "unknown" as const };
          return { key, result: await toCommandAck(client, options.spec, receipt) };
        }),
      );
      return { results };
    },
    async rowsRange(params: V4ConversationRowsRangeParams): Promise<V4ConversationRowsRangeResult> {
      if (params.sessionId !== options.spec.hostSessionId)
        throw new Error("externalHarnessUnsupported:foreign-session");
      return client.conversationRowsRange({
        spec: options.spec,
        sessionId: params.sessionId,
        ...(params.beforeRowId !== undefined ? { beforeRowId: params.beforeRowId } : {}),
        limit: params.limit,
      });
    },
    plans: () => unsupported("plans"),
    workflowRunEvents: () => unsupported("workflowRunEvents"),
    workflowRuns: () => unsupported("workflowRuns"),
    workflowRunArtifacts: () => unsupported("workflowRunArtifacts"),
    workflowRunArtifactData: () => unsupported("workflowRunArtifactData"),
    workflowRunArtifactRead: () => unsupported("workflowRunArtifactRead"),
    workflowRunWorkspace: () => unsupported("workflowRunWorkspace"),
    workflowRunNodeResult: () => unsupported("workflowRunNodeResult"),
    fileChanges: () => unsupported("fileChanges"),
    fileRewindPreview: () => unsupported("fileRewindPreview"),
    attachmentPut: () => unsupported("attachmentPut"),
    attachmentRead: () => unsupported("attachmentRead"),
    attachmentReadRange: () => unsupported("attachmentReadRange"),
    onFrame(listener) {
      ensureUpstream();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onAssemblyFault(listener) {
      faultListeners.add(listener);
      return () => faultListeners.delete(listener);
    },
    onRuntimeRestart: () => () => undefined,
    dispose() {
      upstream?.dispose();
      upstream = undefined;
      barrier.clear();
      decoder.clear();
      subscriptionTopics.clear();
      listeners.clear();
      faultListeners.clear();
    },
  };
}

export async function createExternalAgentSession(
  client: AgentHostConversationClient,
  request: ExternalSessionCreateRequest,
  clientMode: AgentHostConversationTransportOptions["clientMode"],
  runtimePolicy: AgentHostConversationRuntimePolicy = "existing-only",
): Promise<ExternalSessionCreateResult & { transport: AgentHostConversationTransport }> {
  const result = await client.createExternalSession(request);
  return {
    ...result,
    transport: createAgentHostConversationTransport(client, {
      spec: request.spec,
      clientMode,
      runtimePolicy,
    }),
  };
}
