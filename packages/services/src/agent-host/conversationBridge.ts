import { randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import { createServiceLogger } from "../logger/serviceLogger.js";
import {
  agentHostConversationResyncRequestSchema,
  agentHostConversationRowsRangeRequestSchema,
  agentHostConversationSubscribeRequestSchema,
  agentHostConversationUnsubscribeRequestSchema,
  externalSessionCreateRequestSchema,
  externalSessionCreateResultSchema,
  externalSessionLocatorFromSpec,
  type AgentHostConversationFrame,
  type AgentHostConversationResyncRequest,
  type AgentHostConversationResyncResult,
  type AgentHostConversationRowsRangeRequest,
  type AgentHostConversationRowsRangeResult,
  type AgentHostConversationSubscribeRequest,
  type AgentHostConversationSubscribeResult,
  type AgentHostConversationUnsubscribeRequest,
  type AgentEvent,
  type ExternalSessionCreateRequest,
  type ExternalSessionCreateResult,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import {
  V4_WIRE_PROTOCOL_VERSION,
  parseConversationTopic,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";
export interface AgentHostConversationBridgeSource {
  create(spec: SessionSpec): Promise<ConversationSnapshot>;
  attach(spec: SessionSpec): Promise<ConversationSnapshot>;
  snapshot(spec: SessionSpec): Promise<ConversationSnapshot>;
  conversationRowsRange(
    spec: SessionSpec,
    input: { sessionId: string; beforeRowId?: number; limit: number },
  ): Promise<AgentHostConversationRowsRangeResult>;
  subscribe(listener: (event: { spec: SessionSpec; event: AgentEvent }) => void): () => void;
}

interface Subscription {
  readonly spec: SessionSpec;
  readonly topic: string;
  readonly subscriptionId: string;
  ordinal: number;
  lastSeq: number;
  queue: Promise<void>;
  initializing: boolean;
  pendingLive: boolean;
  disposed: boolean;
}

const logger = createServiceLogger("agent-host-conversation");

function sameSessionIdentity(left: SessionSpec, right: SessionSpec): boolean {
  return (
    left.execution.targetId === right.execution.targetId &&
    left.execution.workspaceIdentity === right.execution.workspaceIdentity &&
    left.harness.id === right.harness.id &&
    left.hostSessionId === right.hostSessionId
  );
}

function completeSnapshotFrame(
  subscription: Subscription,
  snapshot: ConversationSnapshot,
  deliveryKind: "initial" | "online" | "recovery",
): AgentHostConversationFrame {
  return {
    wireVersion: V4_WIRE_PROTOCOL_VERSION,
    kind: "complete",
    deliveryKind,
    logicalFrameId: randomUUID(),
    logicalFrameOrdinal: ++subscription.ordinal,
    topic: subscription.topic,
    subscriptionId: subscription.subscriptionId,
    frame: {
      topic: subscription.topic,
      subscriptionId: subscription.subscriptionId,
      fromSeq: 0,
      toSeq: snapshot.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    },
  };
}

/** Host-owned external V4 read/command bridge; it never stores canonical events. */
export function createAgentHostConversationBridge(target: AgentHostConversationBridgeSource): {
  readonly onFrame: (listener: (frame: AgentHostConversationFrame) => void) => { dispose(): void };
  createExternalSession(
    request: ExternalSessionCreateRequest,
  ): Promise<ExternalSessionCreateResult>;
  subscribeConversation(
    request: AgentHostConversationSubscribeRequest,
  ): Promise<AgentHostConversationSubscribeResult>;
  resyncConversation(
    request: AgentHostConversationResyncRequest,
  ): Promise<AgentHostConversationResyncResult>;
  unsubscribeConversation(request: AgentHostConversationUnsubscribeRequest): Promise<void>;
  conversationRowsRange(
    request: AgentHostConversationRowsRangeRequest,
  ): Promise<AgentHostConversationRowsRangeResult>;
  dispose(): void;
} {
  const emitter = new Emitter<AgentHostConversationFrame>();
  const subscriptions = new Map<string, Subscription>();
  const targetUnsubscribe = target.subscribe((event) => handleTargetEvent(event));

  const emitSnapshot = (
    subscription: Subscription,
    snapshot: ConversationSnapshot,
    deliveryKind: "initial" | "online" | "recovery",
    force = false,
  ): void => {
    if (subscription.disposed || (!force && snapshot.seq <= subscription.lastSeq)) return;
    subscription.lastSeq = Math.max(subscription.lastSeq, snapshot.seq);
    emitter.fire(completeSnapshotFrame(subscription, snapshot, deliveryKind));
  };

  const queueLiveSnapshot = (subscription: Subscription): void => {
    if (subscription.initializing) {
      subscription.pendingLive = true;
      return;
    }
    subscription.queue = subscription.queue
      .then(async () => {
        if (subscription.disposed) return;
        emitSnapshot(subscription, await target.snapshot(subscription.spec), "online");
      })
      .catch((error: unknown) => {
        logger.warn(undefined, "external conversation live snapshot failed", {
          errorMessage: error instanceof Error ? error.message : String(error),
          hostSessionId: subscription.spec.hostSessionId,
        });
      });
  };

  function handleTargetEvent(event: { spec: SessionSpec; event: AgentEvent }): void {
    for (const subscription of subscriptions.values()) {
      if (sameSessionIdentity(subscription.spec, event.spec)) queueLiveSnapshot(subscription);
    }
  }

  const getSubscription = (subscriptionId: string): Subscription => {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription || subscription.disposed) throw new Error("fault.subscription.notOwned");
    return subscription;
  };

  return {
    onFrame(listener) {
      return emitter.event(listener);
    },
    async createExternalSession(raw): Promise<ExternalSessionCreateResult> {
      const request = externalSessionCreateRequestSchema.parse(raw);
      const snapshot = await target.create(request.spec);
      return externalSessionCreateResultSchema.parse({
        locator: externalSessionLocatorFromSpec(request.spec),
        snapshot,
      });
    },
    async subscribeConversation(raw): Promise<AgentHostConversationSubscribeResult> {
      const request = agentHostConversationSubscribeRequestSchema.parse(raw);
      if (parseConversationTopic(request.topic) !== request.spec.hostSessionId) {
        throw new Error("fault.subscription.topicIdentityMismatch");
      }
      const subscription: Subscription = {
        spec: request.spec,
        topic: request.topic,
        subscriptionId: randomUUID(),
        ordinal: 0,
        lastSeq: -1,
        queue: Promise.resolve(),
        initializing: true,
        pendingLive: false,
        disposed: false,
      };
      subscriptions.set(subscription.subscriptionId, subscription);
      try {
        // existing-only is a history read; only start-if-needed is allowed to attach/spawn.
        const snapshot =
          request.runtimePolicy === "start-if-needed"
            ? await target.attach(request.spec)
            : await target.snapshot(request.spec);
        // Register first, then build the snapshot. Events during this await are held
        // and caught up after the initial frame, so no sequence is skipped.
        emitSnapshot(subscription, snapshot, "initial", true);
        subscription.initializing = false;
        if (subscription.pendingLive) {
          subscription.pendingLive = false;
          queueLiveSnapshot(subscription);
        }
        return {
          ack: {
            subscriptionId: subscription.subscriptionId,
            mode: "snapshot",
            logEpoch: snapshot.logEpoch,
          },
        };
      } catch (error) {
        subscription.disposed = true;
        subscriptions.delete(subscription.subscriptionId);
        throw error;
      }
    },
    async resyncConversation(raw): Promise<AgentHostConversationResyncResult> {
      const request = agentHostConversationResyncRequestSchema.parse(raw);
      const subscription = getSubscription(request.subscriptionId);
      if (!sameSessionIdentity(subscription.spec, request.spec)) {
        throw new Error("fault.subscription.notOwned");
      }
      await subscription.queue;
      const snapshot = await target.snapshot(subscription.spec);
      emitSnapshot(subscription, snapshot, "recovery", true);
      return {
        ack: {
          subscriptionId: subscription.subscriptionId,
          mode: "snapshot",
          logEpoch: snapshot.logEpoch,
        },
      };
    },
    async unsubscribeConversation(raw): Promise<void> {
      const request = agentHostConversationUnsubscribeRequestSchema.parse(raw);
      const subscription = subscriptions.get(request.subscriptionId);
      if (!subscription) return;
      if (!sameSessionIdentity(subscription.spec, request.spec)) {
        throw new Error("fault.subscription.notOwned");
      }
      subscription.disposed = true;
      subscriptions.delete(request.subscriptionId);
    },
    conversationRowsRange(raw): Promise<AgentHostConversationRowsRangeResult> {
      const request = agentHostConversationRowsRangeRequestSchema.parse(raw);
      return target.conversationRowsRange(request.spec, request);
    },
    dispose(): void {
      for (const subscription of subscriptions.values()) subscription.disposed = true;
      subscriptions.clear();
      targetUnsubscribe();
      emitter.dispose();
    },
  };
}
