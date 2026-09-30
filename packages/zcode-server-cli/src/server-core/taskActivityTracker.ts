import { Emitter, type Event, type IDisposable } from "@zcode/rpc";
import type {
  IZCodeAgentService,
  ZCodeAgentRuntimeLifecycleEvent,
  ZCodeAgentWorkspaceTarget,
} from "@zcode/services";
import type { AgentHostActivityIndex, AgentHostActivityIndexEntry } from "@zcode/services";
import type { ConversationTelemetryFact } from "@zcode/shared/zcode-protocol-v4";
import type { AgentEvent, SessionSpec } from "@zcode/shared/agent-host";
import { countRunningTasks } from "@zcode/services/agent-host/runtime";

interface TaskActivityTracker extends IDisposable {
  readonly onDidChangeRunningTaskCount: Event<number>;
  readRunningTaskCount(): number;
  whenReady(): Promise<void>;
  refreshExternalActivity(): Promise<void>;
}

export interface ExternalTaskActivitySource {
  readonly onEvent: Event<{ spec: SessionSpec; event: AgentEvent }>;
  readIndex(): Promise<AgentHostActivityIndex>;
  retryIntervalMs?: number;
}

type ExternalActivityState = Pick<
  AgentHostActivityIndexEntry,
  "runtimeEpoch" | "sequence" | "state" | "activeTurnId"
> & { pendingInteractionIds: Set<string> };

type ExternalActivityEvent = { spec: SessionSpec; event: AgentEvent };

interface WorkspaceActivity {
  activeSessionIds: Set<string>;
  runtimeIdentity: string;
  telemetry: IDisposable;
}

function workspaceKey(target: ZCodeAgentWorkspaceTarget): string {
  return target.workspaceIdentity?.trim() || target.workspacePath;
}

export function agentHostActivityKey(spec: SessionSpec): string {
  return JSON.stringify([
    spec.execution.targetId,
    spec.execution.workspaceIdentity.trim() || spec.execution.worktreePath,
    spec.harness.id,
    spec.hostSessionId,
  ]);
}

function asActivityState(entry: AgentHostActivityIndexEntry): ExternalActivityState {
  return {
    runtimeEpoch: entry.runtimeEpoch,
    sequence: entry.sequence,
    state: entry.state,
    activeTurnId: entry.activeTurnId,
    pendingInteractionIds: new Set(entry.pendingInteractionIds),
  };
}

function applyExternalEvent(
  state: ExternalActivityState,
  event: AgentEvent,
): "applied" | "stale" | "resync" {
  if (state.runtimeEpoch !== event.runtimeEpoch) {
    state.state = "unknown";
    return "resync";
  }
  if (event.sequence <= state.sequence) return "stale";
  if (event.sequence !== state.sequence + 1) {
    state.state = "unknown";
    return "resync";
  }
  state.sequence = event.sequence;

  switch (event.kind) {
    case "turn.started":
      state.activeTurnId = event.turnId;
      state.state = "busy";
      break;
    case "interaction.requested":
      if (state.activeTurnId && state.activeTurnId !== event.turnId) {
        state.state = "unknown";
        return "resync";
      }
      state.activeTurnId = event.turnId;
      state.pendingInteractionIds.add(event.interactionId);
      state.state = "busy";
      break;
    case "interaction.resolved":
      if (state.activeTurnId !== event.turnId) {
        state.state = "unknown";
        return "resync";
      }
      state.pendingInteractionIds.delete(event.interactionId);
      // 批准或拒绝可能刚改变工具准入，不能据此认定执行已经停止。
      state.state = "busy";
      break;
    case "turn.finished":
      if (state.activeTurnId !== event.turnId) {
        state.state = "unknown";
        return "resync";
      }
      state.activeTurnId = null;
      state.pendingInteractionIds.clear();
      state.state = "idle";
      break;
    case "session.status":
      if (event.state === "idle") {
        state.activeTurnId = null;
        state.pendingInteractionIds.clear();
        state.state = "idle";
      } else if (event.state === "running") {
        state.state = "busy";
      } else {
        state.state = "unknown";
      }
      break;
    case "session.error":
      state.state = "unknown";
      break;
    default:
      if ("turnId" in event && state.activeTurnId !== event.turnId) {
        state.state = "unknown";
        return "resync";
      }
      if (state.activeTurnId) state.state = "busy";
      break;
  }
  return "applied";
}

export function createTaskActivityTracker(
  source:
    | Pick<IZCodeAgentService, "onAgentRuntimeLifecycle" | "onDynamicConversationTelemetryFact">
    | undefined,
  external?: ExternalTaskActivitySource,
): TaskActivityTracker {
  const changed = new Emitter<number>();
  const workspaces = new Map<string, WorkspaceActivity>();
  const externalSessions = new Map<string, ExternalActivityState>();
  let runningTaskCount = 0;
  let externalActivityUncertain = false;
  let refreshNeeded = false;
  let disposed = false;
  let activeSnapshotEvents: ExternalActivityEvent[] | undefined;
  let readInFlight: Promise<void> | undefined;
  let retryTimer: NodeJS.Timeout | undefined;

  const publishCount = (): void => {
    const next = countRunningTasks({
      nativeActiveSessions: [...workspaces.values()].reduce(
        (total, workspace) => total + workspace.activeSessionIds.size,
        0,
      ),
      external: [...externalSessions.values()],
      externalUncertain: externalActivityUncertain,
    });
    if (next === runningTaskCount) return;
    runningTaskCount = next;
    changed.fire(next);
  };

  const removeWorkspace = (key: string, runtimeIdentity?: string): void => {
    const current = workspaces.get(key);
    if (!current || (runtimeIdentity && current.runtimeIdentity !== runtimeIdentity)) return;
    current.telemetry.dispose();
    workspaces.delete(key);
    publishCount();
  };

  const acceptFact = (key: string, fact: ConversationTelemetryFact): void => {
    const workspace = workspaces.get(key);
    if (!workspace) return;
    if (fact.kind === "turn.started") {
      workspace.activeSessionIds.add(fact.sessionId);
    } else if (fact.kind === "turn.terminal") {
      workspace.activeSessionIds.delete(fact.sessionId);
    } else {
      return;
    }
    publishCount();
  };

  const acceptLifecycle = (event: ZCodeAgentRuntimeLifecycleEvent): void => {
    if (disposed) return;
    const key = event.workspaceKey || workspaceKey(event);
    if (event.state === "unavailable") {
      removeWorkspace(key, event.runtimeIdentity.identity);
      return;
    }
    removeWorkspace(key);
    const activeSessionIds = new Set<string>();
    const telemetry = source?.onDynamicConversationTelemetryFact(event)((fact) =>
      acceptFact(key, fact),
    );
    if (!telemetry) return;
    workspaces.set(key, {
      activeSessionIds,
      runtimeIdentity: event.runtimeIdentity.identity,
      telemetry,
    });
  };

  const requestRefresh = (): void => {
    if (!external || disposed) return;
    refreshNeeded = true;
    if (retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void refreshExternalActivity();
    }, external.retryIntervalMs ?? 5_000);
    retryTimer.unref?.();
  };

  const acceptExternalEvent = (entry: ExternalActivityEvent): void => {
    if (disposed) return;
    activeSnapshotEvents?.push(entry);
    const key = agentHostActivityKey(entry.spec);
    let current = externalSessions.get(key);
    if (!current) {
      current = {
        runtimeEpoch: entry.event.runtimeEpoch,
        sequence: 0,
        state: "unknown",
        activeTurnId: null,
        pendingInteractionIds: new Set(),
      };
      externalSessions.set(key, current);
    }
    const result = applyExternalEvent(current, entry.event);
    if (result === "resync") requestRefresh();
    publishCount();
  };

  const reconcileSnapshot = (
    snapshot: AgentHostActivityIndex,
    buffered: readonly ExternalActivityEvent[],
  ): boolean => {
    if (!snapshot.complete || !snapshot.targetId.trim()) return false;
    for (const entry of snapshot.sessions) {
      if (entry.spec.execution.targetId !== snapshot.targetId) return false;
    }
    const seen = new Set<string>();
    let resync = false;
    for (const entry of snapshot.sessions) {
      const key = agentHostActivityKey(entry.spec);
      if (seen.has(key)) return false;
      seen.add(key);
      const current = asActivityState(entry);
      const events = buffered
        .filter((candidate) => agentHostActivityKey(candidate.spec) === key)
        .sort((a, b) => a.event.sequence - b.event.sequence);
      let epochConflict = false;
      for (const candidate of events) {
        if (candidate.event.runtimeEpoch !== current.runtimeEpoch) {
          // Epoch 字符串不可排序；用下一次完整索引确认哪个 owner 仍有效。
          epochConflict = true;
          continue;
        }
        if (candidate.event.sequence <= current.sequence) continue;
        if (applyExternalEvent(current, candidate.event) === "resync") resync = true;
      }
      if (epochConflict) {
        current.state = "unknown";
        resync = true;
      }
      externalSessions.set(key, current);
    }
    for (const [key, current] of externalSessions) {
      if (seen.has(key)) continue;
      const targetId = JSON.parse(key)[0] as string;
      if (targetId === snapshot.targetId && current.state !== "idle") {
        // A missing manifest is not a terminal fact for an observed live owner.
        current.state = "unknown";
        resync = true;
      }
    }
    externalActivityUncertain = false;
    refreshNeeded = resync;
    return true;
  };

  function refreshExternalActivity(): Promise<void> {
    if (!external || disposed) return Promise.resolve();
    if (readInFlight) return readInFlight;
    const buffered: ExternalActivityEvent[] = [];
    activeSnapshotEvents = buffered;
    const attempt = Promise.resolve()
      .then(() => external.readIndex())
      .then((snapshot) => {
        if (!reconcileSnapshot(snapshot, buffered)) {
          externalActivityUncertain = true;
          refreshNeeded = true;
        }
      })
      .catch(() => {
        // 读取失败不会变成 idle；只允许后续完整 target 重扫清除这个 sentinel。
        externalActivityUncertain = true;
        refreshNeeded = true;
      })
      .finally(() => {
        if (activeSnapshotEvents === buffered) activeSnapshotEvents = undefined;
        readInFlight = undefined;
        publishCount();
        if (refreshNeeded || externalActivityUncertain) requestRefresh();
        else if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
      });
    readInFlight = attempt;
    return attempt;
  }

  const lifecycle = source?.onAgentRuntimeLifecycle?.(acceptLifecycle);
  const externalSubscription = external?.onEvent(acceptExternalEvent);
  const ready = refreshExternalActivity();
  return {
    onDidChangeRunningTaskCount: changed.event,
    readRunningTaskCount: () => runningTaskCount,
    whenReady: () => ready,
    refreshExternalActivity,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      lifecycle?.dispose();
      externalSubscription?.dispose();
      for (const workspace of workspaces.values()) workspace.telemetry.dispose();
      workspaces.clear();
      externalSessions.clear();
      externalActivityUncertain = false;
      runningTaskCount = 0;
      changed.dispose();
    },
  };
}
