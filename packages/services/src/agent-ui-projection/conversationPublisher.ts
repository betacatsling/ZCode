import type { AgentEvent, CompatibleSessionSpec } from "@zcode/shared/agent-host";
import {
  projectConversationDelivery,
  type ConversationDelivery,
  type ProjectionClientMode,
} from "./zcodeV4Projector.js";

/** 订阅水位。事件日志仍由 Host 持有，这里不保存第二份队列。 */
export function createConversationPublisher(input: {
  spec: CompatibleSessionSpec;
  runtimeEpoch: string;
  topic: string;
  subscriptionId: string;
  clientMode: ProjectionClientMode;
  now?: () => number;
  windowSize?: number;
}): {
  readonly clientMode: ProjectionClientMode;
  open: (
    events: readonly AgentEvent[],
    base?: { logEpoch: string; seq: number },
  ) => ConversationDelivery;
  push: (events: readonly AgentEvent[]) => ConversationDelivery;
} {
  let deliveredSeq = -1;
  const now = input.now ?? (() => Date.now());
  const deliver = (
    events: readonly AgentEvent[],
    base?: { logEpoch: string; seq: number },
  ): ConversationDelivery => {
    const delivery = projectConversationDelivery({
      spec: input.spec,
      runtimeEpoch: input.runtimeEpoch,
      events,
      topic: input.topic,
      subscriptionId: input.subscriptionId,
      clientMode: input.clientMode,
      ...(base ? { base } : {}),
      ...(input.windowSize !== undefined ? { windowSize: input.windowSize } : {}),
      now: now(),
    });
    if (delivery.mode !== "resync" && "frame" in delivery) deliveredSeq = delivery.frame.toSeq;
    return delivery;
  };
  return {
    clientMode: input.clientMode,
    open(events, base) {
      return deliver(events, base);
    },
    push(events) {
      const base =
        deliveredSeq >= 0 ? { logEpoch: input.runtimeEpoch, seq: deliveredSeq } : undefined;
      return deliver(events, base);
    },
  };
}
