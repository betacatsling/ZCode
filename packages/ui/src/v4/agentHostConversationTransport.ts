import type { Event } from "@zcode/rpc";
import {
  type AgentCommand,
  type AgentCommandReceipt,
  type AgentEvent,
  type SessionSpec,
  type SessionSpecV2,
} from "@zcode/shared/agent-host";
import {
  parseConversationTopic,
  type ConversationSnapshot,
  type ConversationTopicFrame,
  type TopicFrameDeliveryKind,
  type V4ConversationRowsRangeParams,
  type V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { ack, createHostSendCommand, unsupported } from "./agentHostConversationCommands.js";
import { createAckActivationBarrier } from "./ackActivationBarrier.js";
import type { ConversationTransport } from "./transport.js";

export type ReadableHostSession = SessionSpecV2 | SessionSpec;
/** Supplied by the scoped, persisted Host owner index, never inferred from a session ID or path. */
export interface HostSessionOwner {
  readonly spec: ReadableHostSession;
  /** Legacy v1 records are readable after a worktree disappears but never writable. */
  readonly historyOnly?: boolean;
}

/** Structural subset of the target Host service. No renderer-side journal or projector. */
export interface AgentHostConversationPort {
  readonly onEvent: Event<{ spec: ReadableHostSession; event: AgentEvent }>;
  create(spec: SessionSpecV2, commandId: string): Promise<ConversationSnapshot>;
  dispatch(spec: SessionSpecV2, command: AgentCommand): Promise<AgentCommandReceipt>;
  snapshot(spec: ReadableHostSession): Promise<ConversationSnapshot>;
  eventsSince(spec: ReadableHostSession, sequence: number): Promise<readonly AgentEvent[]>;
  queryCommand(
    spec: ReadableHostSession,
    commandId: string,
  ): Promise<AgentCommandReceipt | undefined>;
  queryCreationCommand(
    commandId: string,
  ): Promise<{ spec: SessionSpecV2; receipt: AgentCommandReceipt } | undefined>;
  rowsRange(
    spec: ReadableHostSession,
    request: V4ConversationRowsRangeParams,
  ): Promise<V4ConversationRowsRangeResult>;
  getSessionSpec(scope: {
    targetId: string;
    workspaceId: string;
    hostSessionId: string;
  }): Promise<SessionSpecV2 | undefined>;
}

export interface AgentHostConversationScope {
  targetId: string;
  workspaceId: string;
  workspaceIdentity: string;
  worktreePath: string;
  /** Must read the trusted, scoped owner index; absence is not a native fallback. */
  locateExternal: (hostSessionId: string) => Promise<HostSessionOwner | undefined>;
}

export interface AgentHostConversationTransport extends ConversationTransport {
  dispose(): void;
}

function sameSpec(a: ReadableHostSession, b: ReadableHostSession): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Only a target-scoped owner can authorize reads; v1 is history-only, even after path removal. */
export function createAgentHostConversationTransport(
  service: AgentHostConversationPort,
  scope: AgentHostConversationScope,
): AgentHostConversationTransport {
  type Sub = {
    topic: string;
    spec: ReadableHostSession;
    epoch: string;
    seq: number;
    active: boolean;
    dirty: boolean;
    latestEvent?: AgentEvent;
    pending?: Promise<void>;
  };
  const subs = new Map<string, Sub>();
  const frameListeners = new Set<Parameters<ConversationTransport["onFrame"]>[0]>();
  const faultListeners = new Set<Parameters<ConversationTransport["onAssemblyFault"]>[0]>();
  const barrier = createAckActivationBarrier<{
    topic: string;
    subscriptionId: string;
    frame: ConversationTopicFrame;
    kind: TopicFrameDeliveryKind;
  }>((staged) => {
    for (const listener of frameListeners) listener(staged.frame, { deliveryKind: staged.kind });
  });
  const emit = (
    id: string,
    sub: Sub,
    snapshot: ConversationSnapshot,
    kind: TopicFrameDeliveryKind,
  ) => {
    if (subs.get(id) !== sub || snapshot.sessionId !== sub.spec.hostSessionId) return;
    if (snapshot.logEpoch === sub.epoch && snapshot.seq < sub.seq) return;
    // Bug 原因：外部 Host 的 runtimeEpoch 换代后，旧 seq 不能与新纪元 merge。只使用 Host 权威 snapshot 整体替换。
    sub.epoch = snapshot.logEpoch;
    sub.seq = snapshot.seq;
    const frame: ConversationTopicFrame = {
      topic: sub.topic,
      subscriptionId: id,
      fromSeq: 0,
      toSeq: snapshot.seq,
      sentAt: Date.now(),
      payload: { kind: "snapshot", snapshot },
    };
    barrier.accept({ topic: sub.topic, subscriptionId: id, frame, kind });
  };
  const resolve = async (id: string): Promise<HostSessionOwner> => {
    const owner = await scope.locateExternal(id);
    if (
      !owner ||
      owner.spec.hostSessionId !== id ||
      owner.spec.execution.targetId !== scope.targetId ||
      owner.spec.execution.workspaceIdentity !== scope.workspaceIdentity ||
      owner.spec.execution.worktreePath !== scope.worktreePath ||
      (owner.spec.schemaVersion === 2 && owner.spec.workspaceId !== scope.workspaceId)
    ) {
      throw new Error(`unknown external session owner: ${id}`);
    }
    if (owner.spec.schemaVersion === 2) {
      const stored = await service.getSessionSpec({
        targetId: scope.targetId,
        workspaceId: scope.workspaceId,
        hostSessionId: id,
      });
      if (!stored || !sameSpec(stored, owner.spec))
        throw new Error(`stale external session owner: ${id}`);
    } else if (!owner.historyOnly)
      throw new Error("legacy external session requires history-only owner record");
    return owner;
  };
  const snapshotFor = async (spec: ReadableHostSession): Promise<ConversationSnapshot> => {
    const snapshot = await service.snapshot(spec);
    if (
      snapshot.sessionId !== spec.hostSessionId ||
      snapshot.agentHost?.hostSessionId !== spec.hostSessionId ||
      snapshot.agentHost?.targetId !== scope.targetId ||
      snapshot.agentHost?.harnessId !== spec.harness.id
    ) {
      throw new Error("external snapshot owner mismatch");
    }
    return snapshot;
  };
  const requireSub = (id: string): Sub => {
    const sub = subs.get(id);
    if (!sub) throw new Error(`unknown external subscription: ${id}`);
    return sub;
  };
  const refresh = (id: string, sub: Sub) => {
    if (!sub.active || sub.pending || !sub.dirty || subs.get(id) !== sub) return;
    // Bug 原因：逐 token 创建一个完整 snapshot 会积压无界读取与 ACK 前的大帧；
    // 一次只保留最新事件水位，读取期间的新事件至多触发下一次读取。
    sub.pending = (async () => {
      while (sub.dirty && subs.get(id) === sub) {
        sub.dirty = false;
        const event = sub.latestEvent;
        if (!event || (event.runtimeEpoch === sub.epoch && event.sequence <= sub.seq)) continue;
        if (event.runtimeEpoch === sub.epoch && event.sequence > sub.seq + 1) {
          const missing = await service.eventsSince(sub.spec, sub.seq);
          if (
            missing[0]?.sequence !== sub.seq + 1 ||
            missing.some(
              (entry, index) =>
                entry.hostSessionId !== sub.spec.hostSessionId ||
                entry.runtimeEpoch !== sub.epoch ||
                entry.sequence !== sub.seq + index + 1,
            )
          ) {
            for (const listener of faultListeners)
              listener({ topic: sub.topic, subscriptionId: id, reasonCode: "externalEventGap" });
          }
        }
        const snapshot = await snapshotFor(sub.spec);
        if (snapshot.logEpoch !== sub.epoch || snapshot.seq !== sub.seq)
          emit(id, sub, snapshot, "online");
      }
    })()
      .catch(() => {
        if (subs.get(id) === sub)
          for (const listener of faultListeners)
            listener({
              topic: sub.topic,
              subscriptionId: id,
              reasonCode: "externalSnapshotUnavailable",
            });
      })
      .finally(() => {
        sub.pending = undefined;
        if (sub.dirty) refresh(id, sub);
      });
  };
  const offEvent = service.onEvent(({ spec, event }) => {
    for (const [id, sub] of subs) {
      if (!sameSpec(spec, sub.spec) || event.hostSessionId !== sub.spec.hostSessionId) continue;
      sub.latestEvent = event;
      sub.dirty = true;
      refresh(id, sub);
    }
  });
  let disposed = false;
  const transport: AgentHostConversationTransport = {
    async subscribe(params) {
      if (disposed) throw new Error("external transport disposed");
      const id = parseConversationTopic(params.topic);
      if (!id) throw new Error("unsupported external topic");
      const owner = await resolve(id);
      const subscriptionId = `host-${crypto.randomUUID()}`;
      const token = barrier.begin(params.topic);
      const sub: Sub = {
        topic: params.topic,
        spec: owner.spec,
        epoch: "",
        seq: 0,
        active: false,
        dirty: false,
      };
      subs.set(subscriptionId, sub);
      try {
        const snapshot = await snapshotFor(owner.spec);
        sub.epoch = snapshot.logEpoch;
        barrier.bind(token, subscriptionId);
        emit(subscriptionId, sub, snapshot, "initial");
        return { ack: { subscriptionId, mode: "snapshot", logEpoch: snapshot.logEpoch } };
      } catch (error) {
        subs.delete(subscriptionId);
        barrier.cancel(token);
        throw error;
      }
    },
    activate(id) {
      const sub = requireSub(id);
      barrier.activate(id);
      sub.active = true;
      refresh(id, sub);
    },
    async resync(params) {
      const sub = requireSub(params.subscriptionId);
      await sub.pending;
      const snapshot = await snapshotFor(sub.spec);
      emit(params.subscriptionId, sub, snapshot, "recovery");
      return {
        ack: {
          subscriptionId: params.subscriptionId,
          mode: "snapshot",
          logEpoch: snapshot.logEpoch,
        },
      };
    },
    async unsubscribe(id) {
      requireSub(id);
      subs.delete(id);
      barrier.forget(id);
    },
    sendCommand: createHostSendCommand(service, scope, resolve, snapshotFor),
    async queryCommands(params) {
      if (params.clock) return unsupported("external clock probe");
      return {
        results: await Promise.all(
          params.commands.map(async (key) => {
            if (!key.sessionId) {
              const creation = await service.queryCreationCommand(key.commandId);
              if (
                creation &&
                (creation.receipt.commandId !== key.commandId ||
                  creation.spec.execution.targetId !== scope.targetId ||
                  creation.spec.workspaceId !== scope.workspaceId ||
                  creation.spec.execution.workspaceIdentity !== scope.workspaceIdentity ||
                  creation.spec.execution.worktreePath !== scope.worktreePath)
              )
                throw new Error("external create owner mismatch");
              return {
                key,
                result: creation
                  ? ack(creation.receipt, 0, {
                      type: "createSession",
                      sessionId: creation.spec.hostSessionId,
                    })
                  : ("unknown" as const),
              };
            }
            const owner = await resolve(key.sessionId);
            const receipt = await service.queryCommand(owner.spec, key.commandId);
            return { key, result: receipt ? ack(receipt, 0) : ("unknown" as const) };
          }),
        ),
      };
    },
    async rowsRange(params) {
      const owner = await resolve(params.sessionId);
      return service.rowsRange(owner.spec, params);
    },
    plans(params) {
      return unsupported(`plans ${params.sessionId}`);
    },
    workflowRunEvents(params) {
      return unsupported(`workflowRunEvents ${params.sessionId}`);
    },
    workflowRuns(params) {
      return unsupported(`workflowRuns ${params.sessionId}`);
    },
    workflowRunArtifacts(params) {
      return unsupported(`workflowRunArtifacts ${params.sessionId}`);
    },
    workflowRunArtifactData(params) {
      return unsupported(`workflowRunArtifactData ${params.sessionId}`);
    },
    workflowRunArtifactRead(params) {
      return unsupported(`workflowRunArtifactRead ${params.sessionId}`);
    },
    workflowRunWorkspace(params) {
      return unsupported(`workflowRunWorkspace ${params.sessionId}`);
    },
    workflowRunNodeResult(params) {
      return unsupported(`workflowRunNodeResult ${params.sessionId}`);
    },
    fileChanges(params) {
      return unsupported(`fileChanges ${params.sessionId}`);
    },
    fileRewindPreview(params) {
      return unsupported(`fileRewindPreview ${params.sessionId}`);
    },
    attachmentPut(params) {
      return unsupported(`attachmentPut ${params.sessionId}`);
    },
    attachmentRead(params) {
      return unsupported(`attachmentRead ${params.sessionId}`);
    },
    attachmentReadRange(params) {
      return unsupported(`attachmentReadRange ${params.sessionId}`);
    },
    onFrame(listener) {
      frameListeners.add(listener);
      return () => {
        frameListeners.delete(listener);
      };
    },
    onAssemblyFault(listener) {
      faultListeners.add(listener);
      return () => {
        faultListeners.delete(listener);
      };
    },
    onRuntimeRestart() {
      return () => {};
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      offEvent.dispose();
      subs.clear();
      barrier.clear();
      frameListeners.clear();
      faultListeners.clear();
    },
  };
  return transport;
}
