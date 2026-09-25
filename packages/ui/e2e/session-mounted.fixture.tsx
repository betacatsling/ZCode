/* eslint-disable max-lines -- 浏览器隔离夹具把两个 Pi 会话、可控 Host 事件和原生 RPC 拦截放在同一生命周期内，防止跨测试共享后端事实。 */
import * as React from "react";
import { createRoot } from "react-dom/client";
import type {
  IServiceAccessor,
  IAgentHostService,
  IWorkspaceHierarchyService,
} from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import type { AgentEvent, HarnessCapabilitiesV2, SessionSpecV2 } from "@zcode/shared/agent-host";
import {
  conversationSnapshotSchema,
  type ConversationSnapshot,
  type ConversationRow,
} from "@zcode/shared/zcode-protocol-v4";
import initialSnapshot from "./session-mounted-snapshot.json";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { SessionPane } from "../src/v4/SessionPane.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import type { MountedSessionOwner } from "../src/v4/mountedSessionOwner.js";
import "@zcode/ui/styles.css";

const scope = {
  targetId: "target-test",
  workspaceId: "worktree-test",
  workspaceIdentity: "identity-test",
  workspacePath: "/test/worktree",
};
const specs: SessionSpecV2[] = ["one", "two"].map((id) => ({
  schemaVersion: 2,
  hostSessionId: `pi-${id}`,
  projectId: "project-test",
  workspaceId: scope.workspaceId,
  execution: {
    targetId: scope.targetId,
    workspaceIdentity: scope.workspaceIdentity,
    worktreePath: scope.workspacePath,
    worktreeGeneration: "generation-test",
    cwdRelativeToWorktree: ".",
  },
  harness: { id: "pi", adapterVersion: "1" },
  modelBinding: {
    kind: "host-managed",
    selection: { providerId: "fixture-provider", modelId: `model-${id}` },
  },
}));
const owners: MountedSessionOwner[] = specs.map((spec) => ({
  kind: "external",
  scope,
  spec,
  historyOnly: false,
}));
const logs = new Map(specs.map((spec) => [spec.hostSessionId, [] as AgentEvent[]]));
const listeners = new Set<(value: { spec: SessionSpecV2; event: AgentEvent }) => void>();
const dispatches: string[] = [];
let dispatchLog = "";
const dispatchLogListeners = new Set<() => void>();
let nativeCalls = 0;
let rejectApproval = true;
let unknownNextSend = false;
let textSupported = true;
const receipts = new Map<string, { commandId: string; status: "accepted" | "rejected" }>();
function emit(spec: SessionSpecV2, fields: { kind: AgentEvent["kind"]; [key: string]: unknown }) {
  const list = logs.get(spec.hostSessionId)!;
  const sequence = list.length + 1;
  const event = {
    ...fields,
    hostSessionId: spec.hostSessionId,
    runtimeEpoch: "epoch",
    sequence,
    eventId: `${spec.hostSessionId}-${sequence}`,
    at: Date.now(),
  } as AgentEvent;
  list.push(event);
  for (const listener of listeners) listener({ spec, event });
}
const supported = { support: "supported" as const };
const unsupported = { support: "unsupported" as const, reason: "Not supported by this harness" };
const capabilities: HarnessCapabilitiesV2 = {
  text: supported,
  approvals: supported,
  cancelTurn: supported,
  history: supported,
  viewHistory: supported,
  tools: supported,
  resumeExecution: unsupported,
  images: unsupported,
  modelSwitch: unsupported,
  detach: supported,
  terminateSession: unsupported,
  hostManagedModel: supported,
  fork: unsupported,
  subagents: unsupported,
};
const hierarchy: IWorkspaceHierarchyService = {
  async resolveWorkspace() {
    return scope;
  },
  async resolveOwner({ sessionId }) {
    return owners.find(
      (owner) => owner.kind === "external" && owner.spec.hostSessionId === sessionId,
    );
  },
  async listHarnesses() {
    return [
      {
        manifest: { schemaVersion: 1, id: "pi", name: "Pi", adapterVersion: "1" },
        availability: "supported",
      },
    ];
  },
  async capabilities() {
    return textSupported ? capabilities : { ...capabilities, text: unsupported };
  },
  async asset() {
    return undefined;
  },
  async createAgent() {
    throw new Error("Creation belongs to the real hierarchy service");
  },
};
function projectFixtureSnapshot(spec: SessionSpecV2): ConversationSnapshot {
  const events = logs.get(spec.hostSessionId) ?? [];
  const rows: ConversationRow[] = [];
  let activeTurn: string | undefined;
  let approval: ConversationSnapshot["pendingInteractions"][number] | undefined;
  for (const event of events) {
    if (event.kind === "turn.started") {
      activeTurn = event.turnId;
      rows.push({
        kind: "turnHeader",
        rowId: rows.length + 1,
        turnId: event.turnId,
        createdAt: event.at,
        createdAtSeq: event.sequence,
        origin: "userInput",
        executionKind: "agent",
        state: "running",
        startedAt: event.at,
      });
    }
    if (event.kind === "message.finished" && event.role === "user")
      rows.push({
        kind: "userInput",
        rowId: rows.length + 1,
        turnId: event.turnId,
        createdAt: event.at,
        createdAtSeq: event.sequence,
        origin: "realUser",
        text: event.text,
      });
    if (event.kind === "tool.started")
      rows.push({
        kind: "toolCall",
        rowId: rows.length + 1,
        turnId: event.turnId,
        createdAt: event.at,
        createdAtSeq: event.sequence,
        toolCallId: event.toolCallId,
        toolName: event.name,
        inputText: "",
        status: "running",
        startedAt: event.at,
      });
    if (event.kind === "interaction.requested")
      approval = {
        interactionId: event.interactionId,
        kind: "permission",
        anchorRowId: null,
        createdAt: event.at,
        payload: {
          kind: "permission",
          toolCallId: event.toolCallId,
          toolName: "write",
          summary: event.summary,
          detail: null,
          options: [
            { optionId: "allow", label: "Allow once", kind: "allowOnce" },
            { optionId: "deny", label: "Deny", kind: "deny" },
          ],
        },
      };
    if (event.kind === "interaction.resolved") approval = undefined;
  }
  return conversationSnapshotSchema.parse({
    ...initialSnapshot,
    sessionId: spec.hostSessionId,
    seq: events.length,
    revision: events.length,
    agentHost: { ...initialSnapshot.agentHost, hostSessionId: spec.hostSessionId },
    config: {
      ...initialSnapshot.config,
      modelSelection:
        spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection : undefined,
      model: spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection.modelId : "",
    },
    control: {
      ...initialSnapshot.control,
      phase: activeTurn ? "running" : "draft",
      canStop: Boolean(activeTurn),
      stopState: activeTurn ? "stoppable" : "idle",
      stopTargetKind: activeTurn ? "assistant" : "unknown",
      activeWorks: activeTurn
        ? [
            {
              kind: "primaryTurn",
              foregroundExecutionId: activeTurn,
              startedAt: events[0]?.at ?? 0,
            },
          ]
        : [],
    },
    pendingInteractions: approval ? [approval] : [],
    rows: { window: rows, totalCount: rows.length, firstRowId: rows[0]?.rowId ?? null },
  });
}
const host: IAgentHostService = {
  onEvent(listener) {
    listeners.add(listener);
    return {
      dispose: () => {
        listeners.delete(listener);
      },
    };
  },
  async catalogForTarget() {
    return [];
  },
  async getSessionCapabilities() {
    return capabilities;
  },
  async getRuntimeActivity() {
    return { running: 0, waiting: 0, uncertain: 0 };
  },
  async getSessionSpec({ hostSessionId }) {
    return specs.find((item) => item.hostSessionId === hostSessionId);
  },
  async listWorkspaceSessions() {
    return [];
  },
  async getAvailability() {
    return {
      target: { id: scope.targetId, kind: "local", platform: "darwin", available: true },
      harnesses: ["pi"],
      admissionEnabled: true,
    };
  },
  async listSessions() {
    return [];
  },
  async create() {
    throw new Error("No fixture creation");
  },
  async queryCreationCommand() {
    return undefined;
  },
  async attach(spec) {
    return this.snapshot(spec);
  },
  async dispatch(spec, command) {
    dispatches.push(`${spec.hostSessionId}:${command.type}:${command.commandId}`);
    dispatchLog = dispatches.join("|");
    for (const listener of dispatchLogListeners) listener();
    if (command.type === "resolveInteraction" && rejectApproval)
      return { commandId: command.commandId, status: "rejected", reasonCode: "unsupported" };
    if (command.type === "send") {
      receipts.set(command.commandId, { commandId: command.commandId, status: "accepted" });
      emit(spec, { kind: "turn.started", turnId: command.turnId });
      emit(spec, {
        kind: "message.finished",
        turnId: command.turnId,
        messageId: command.commandId,
        role: "user",
        text: command.text,
      });
    }
    if (command.type === "send" && unknownNextSend) {
      unknownNextSend = false;
      return { commandId: command.commandId, status: "execution-unknown" };
    }
    if (command.type === "resolveInteraction")
      emit(spec, {
        kind: "interaction.resolved",
        turnId: command.turnId,
        interactionId: command.interactionId,
        decision: command.decision,
      });
    return { commandId: command.commandId, status: "accepted" };
  },
  async snapshot(spec) {
    return projectFixtureSnapshot(spec);
  },
  async eventsSince(spec, sequence) {
    return (logs.get(spec.hostSessionId) ?? []).filter((event) => event.sequence > sequence);
  },
  async queryCommand(_spec, commandId) {
    return receipts.get(commandId);
  },
  async rowsRange(spec) {
    const snapshot = await this.snapshot(spec);
    return {
      rows: snapshot.rows.window,
      atSeq: snapshot.seq,
      atRevision: snapshot.revision,
      atLogEpoch: snapshot.logEpoch,
      hasMore: false,
    };
  },
};
// A background Host event, without a browser click, proves it cannot steal composer focus.
Object.assign(window, {
  __mountedBackgroundEvent: () => {
    const spec = specs[0]!;
    const events = logs.get(spec.hostSessionId)!;
    const active = events.find((event) => event.kind === "turn.started");
    if (!active || active.kind !== "turn.started") return;
    emit(spec, {
      kind: "message.finished",
      turnId: active.turnId,
      messageId: `background-${events.length}`,
      role: "assistant",
      text: "background progress",
    });
  },
});
// Test-only controlled transport: every native invocation fails and is counted. No production fallback.
const nativeAgent = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === "onDynamicConversationFrame" || key === "onDynamicLocalTtftFacts")
        return () => () => ({ dispose() {} });
      if (key === "onAgentRuntimeRestarted" || key === "onAgentRuntimeLifecycle")
        return () => ({ dispose() {} });
      return () => {
        nativeCalls++;
        throw new Error(`native RPC called: ${String(key)}`);
      };
    },
  },
);
const services = {
  agentHostService: host,
  workspaceHierarchyService: hierarchy,
  zcodeAgentService: nativeAgent,
} as IServiceAccessor;
const platform = {} as IPlatformService;
function Fixture() {
  const visibleDispatchLog = React.useSyncExternalStore(
    (listener) => {
      dispatchLogListeners.add(listener);
      return () => {
        dispatchLogListeners.delete(listener);
      };
    },
    () => dispatchLog,
  );
  const [selected, select] = React.useState("pi-one");
  const [mounted, setMounted] = React.useState(true);
  const current = owners.find(
    (owner) => owner.kind === "external" && owner.spec.hostSessionId === selected,
  );
  return (
    <main className="flex h-screen flex-col bg-background text-foreground text-ui-base">
      <nav className="flex gap-2 p-2">
        <button onClick={() => select("pi-one")}>Pi one</button>
        <button onClick={() => select("pi-two")}>Pi two</button>
        <button
          onClick={() => {
            select("native-unknown");
          }}
        >
          Native unknown
        </button>
        <button onClick={() => setMounted((value) => !value)}>Reconnect view</button>
        <button
          onClick={() => {
            const spec = specs[0]!;
            const list = logs.get(spec.hostSessionId)!;
            const active = list.find((event) => event.kind === "turn.started");
            if (!active || active.kind !== "turn.started") return;
            emit(spec, {
              kind: "tool.started",
              turnId: active.turnId,
              toolCallId: "tool-1",
              name: "write",
            });
            emit(spec, {
              kind: "interaction.requested",
              turnId: active.turnId,
              toolCallId: "tool-1",
              interactionId: "approval-1",
              summary: "write",
            });
          }}
        >
          Request approval
        </button>
        <button
          onClick={() => {
            unknownNextSend = true;
          }}
        >
          Unknown next send
        </button>
        <button
          onClick={() => {
            textSupported = !textSupported;
            setMounted(false);
          }}
        >
          Toggle text capability
        </button>
        <button
          onClick={() => {
            rejectApproval = false;
          }}
        >
          Accept next approval
        </button>
      </nav>
      <output data-testid="dispatch-log">{visibleDispatchLog}</output>
      <output data-testid="native-calls">{nativeCalls}</output>
      {mounted && current?.kind === "external" ? (
        <section className="min-h-0 flex-1">
          <SessionPane
            paneId="fixture"
            sessionId={selected}
            mountedOwner={current}
            mountedSessionRouting="scoped"
            workspacePath={scope.workspacePath}
            workspaceIdentity={scope.workspaceIdentity}
          />
        </section>
      ) : mounted && selected === "native-unknown" ? (
        <SessionPane
          paneId="fixture"
          sessionId={selected}
          mountedSessionRouting="scoped"
          workspacePath={scope.workspacePath}
          workspaceIdentity={scope.workspaceIdentity}
        />
      ) : (
        <p role="status">View detached; Host continues</p>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <PlatformProvider platform={platform}>
      <ServiceProvider services={services}>
        <TooltipProvider>
          <Fixture />
        </TooltipProvider>
      </ServiceProvider>
    </PlatformProvider>
  </ZCodeIntlProvider>,
);
