/* eslint-disable max-lines -- End-to-end shell fixture owns one controlled Catalog, Host transport and native RPC spy. */
import * as React from "react";
import { createRoot } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import type { SidebarSnapshot } from "@zcode/shared/project-workspaces";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import { conversationSnapshotSchema } from "@zcode/shared/zcode-protocol-v4";
import { WorkspaceShellLayout } from "../src/app-shell/WorkspaceShellLayout.js";
import type { WorkspaceShellLayoutProps } from "../src/app-shell/types.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TabStoreProvider, useTabStoreApi } from "../src/store/TabStoreProvider.js";
import { StoreProvider } from "../src/store/StoreProvider.js";
import { CodingPlanUpgradeDialogProvider } from "../src/settings/CodingPlanUpgradeDialogProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import initialSnapshot from "./session-mounted-snapshot.json";
import "@zcode/ui/styles.css";

const path = "/fixture/worktree";
const identity = "target:fixture";
const scope = {
  targetId: "fixture",
  workspaceId: "ws",
  workspacePath: path,
  workspaceIdentity: identity,
};
const specs: SessionSpecV2[] = ["one", "two"].map((id) => ({
  schemaVersion: 2,
  hostSessionId: `pi-${id}`,
  projectId: "project",
  workspaceId: "ws",
  execution: {
    targetId: "fixture",
    workspaceIdentity: identity,
    worktreePath: path,
    worktreeGeneration: "generation",
    cwdRelativeToWorktree: ".",
  },
  harness: { id: "pi", adapterVersion: "1" },
  modelBinding: {
    kind: "host-managed",
    selection: { providerId: "fixture", modelId: `model-${id}` },
  },
}));
const owners = new Map<string, object>([
  ["alias-native", { kind: "native", scope, originalSessionId: "original-native" }],
  ...specs.map(
    (spec) => [spec.hostSessionId, { kind: "external", scope, spec, historyOnly: false }] as const,
  ),
]);
const sessions = [
  { id: "alias-native", title: "Native session", harnessId: "zcode" },
  { id: "pi-one", title: "Pi one", harnessId: "pi" },
  { id: "pi-two", title: "Pi two", harnessId: "pi" },
  { id: "orphan", title: "Unknown owner", harnessId: "pi" },
];
const snapshot: SidebarSnapshot = {
  schemaVersion: 1,
  revision: 1,
  projects: [{ schemaVersion: 1, id: "project", name: "Project", sortOrder: 0 }],
  bindings: [
    {
      schemaVersion: 1,
      id: "binding",
      projectId: "project",
      executionTargetId: "fixture",
      gitCommonDir: "/fixture/.git",
    },
  ],
  workspaces: [
    {
      schemaVersion: 1,
      id: "ws",
      projectId: "project",
      repositoryBindingId: "binding",
      title: "Worktree",
      sortOrder: 0,
      hidden: false,
      workspaceIdentity: identity,
      worktreePath: path,
      worktreeGeneration: "generation",
      isMainWorktree: true,
      head: { kind: "branch", ref: "main", oid: null },
      origin: "adopted",
      lifecycle: "active",
    },
  ],
  sessions: sessions.map((item, sortOrder) => ({
    session: {
      schemaVersion: 1,
      ...item,
      projectId: "project",
      workspaceId: "ws",
      archived: false,
      sortOrder,
    },
    activity: "idle" as const,
    freshness: "live" as const,
    unread: false,
    updatedAt: 1,
  })),
  workspaceSummaries: [
    {
      workspaceId: "ws",
      freshness: "live",
      totalAgents: 4,
      waiting: 0,
      running: 0,
      errors: 0,
      unreadCompleted: 0,
    },
  ],
  projectSummaries: [
    {
      projectId: "project",
      totalAgents: 4,
      waiting: 0,
      running: 0,
      errors: 0,
      unreadCompleted: 0,
      attentionSessionIds: [],
    },
  ],
};
const events: string[] = [];
let changed = () => {};
let nativeCalls = 0;
let nativeSubscriptions = 0;
let createCalls = 0;
const hierarchy = {
  resolveOwner: async ({
    targetId,
    workspaceId,
    sessionId,
  }: {
    targetId: string;
    workspaceId: string;
    sessionId: string;
  }) => {
    events.push(`resolve:${sessionId}`);
    changed();
    return targetId === "fixture" && workspaceId === "ws" ? owners.get(sessionId) : undefined;
  },
  listHarnesses: async () => [
    {
      manifest: { schemaVersion: 1, id: "zcode", name: "ZCode", adapterVersion: "1" },
      availability: "supported",
    },
    {
      manifest: { schemaVersion: 1, id: "pi", name: "Pi", adapterVersion: "1" },
      availability: "supported",
    },
  ],
  asset: async () => undefined,
  createAgent: async () => {
    createCalls++;
    changed();
    throw new Error("Creation not in fixture");
  },
  capabilities: async () => ({
    text: { support: "supported" },
    history: { support: "supported" },
    viewHistory: { support: "supported" },
    cancelTurn: { support: "supported" },
    approvals: { support: "supported" },
    hostManagedModel: { support: "supported" },
    tools: { support: "supported" },
    detach: { support: "supported" },
  }),
};
const noEvent = () => ({ dispose() {} });
const native = new Proxy(
  {},
  {
    get(_target, key) {
      if (key === "onDynamicConversationFrame" || key === "onDynamicLocalTtftFacts")
        return () => {
          nativeSubscriptions++;
          return () => noEvent();
        };
      if (String(key).startsWith("on"))
        return () => {
          nativeSubscriptions++;
          changed();
          return noEvent();
        };
      return async () => {
        nativeCalls++;
        changed();
        throw new Error(`native RPC: ${String(key)}`);
      };
    },
  },
);
const services = {
  broadcastService: {
    onMessage: noEvent,
    onDidChange: noEvent,
    broadcast: () => {},
    send: () => {},
  },
  workspaceHierarchyService: hierarchy,
  projectCatalogService: {
    sidebarSnapshot: async () => snapshot,
    importProject: async () => {
      throw new Error("Unsupported");
    },
    discover: async () => [],
    adopt: async () => {
      throw new Error("Unsupported");
    },
    create: async () => {
      throw new Error("Unsupported");
    },
    updateWorkspace: async () => {
      throw new Error("Unsupported");
    },
  },
  agentHostService: {
    onEvent: noEvent,
    catalogForTarget: async () => [],
    getSessionCapabilities: async () => hierarchy.capabilities(),
    getSessionSpec: async ({ hostSessionId }: { hostSessionId: string }) =>
      specs.find((s) => s.hostSessionId === hostSessionId),
    attach: async (spec: SessionSpecV2) =>
      conversationSnapshotSchema.parse({
        ...initialSnapshot,
        sessionId: spec.hostSessionId,
        agentHost: {
          ...initialSnapshot.agentHost,
          targetId: spec.execution.targetId,
          hostSessionId: spec.hostSessionId,
        },
        config: {
          ...initialSnapshot.config,
          model:
            spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection.modelId : "",
        },
      }),
    snapshot: async (spec: SessionSpecV2) =>
      conversationSnapshotSchema.parse({
        ...initialSnapshot,
        sessionId: spec.hostSessionId,
        agentHost: {
          ...initialSnapshot.agentHost,
          targetId: spec.execution.targetId,
          hostSessionId: spec.hostSessionId,
        },
        config: {
          ...initialSnapshot.config,
          model:
            spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection.modelId : "",
        },
      }),
    eventsSince: async () => [],
    queryCommand: async () => undefined,
  },
  zcodeAgentService: native,
} as unknown as IServiceAccessor;
const platform = { getInstalledEditors: async () => [] } as unknown as IPlatformService;
function SeededFixture() {
  const store = useTabStoreApi();
  const [seeded, setSeeded] = React.useState(false);
  React.useEffect(() => {
    store.getState().addTab(path, { workspaceIdentity: identity });
    setSeeded(true);
  }, [store]);
  return seeded ? <Fixture /> : null;
}
function Fixture() {
  const [, setTick] = React.useState(0);
  changed = () => setTick((tick) => tick + 1);
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null);
  const noop = () => {};
  const props = {
    services,
    platform,
    workspaceAbsPath: path,
    workspaceIdentity: identity,
    workspaceTabs: [{ workspacePath: path, workspaceIdentity: identity, label: "Worktree" }],
    reconnectingRemoteWorkspaceKeys: [],
    remoteWorkspaceErrorByWorkspaceKey: {},
    projectName: "Project",
    workspaceMainView: "chat",
    isDesktop: true,
    isSidebarVisible: true,
    isBrowserOpen: false,
    isTerminalOpen: false,
    isSidePaneOpen: false,
    isGitOpen: false,
    activeTaskId,
    sidePaneOwnerId: activeTaskId,
    activeSessionId: activeTaskId,
    workspaceShellZCodeState: {
      activeTaskId,
      optimisticTaskListByTaskId: {},
      workspaceInit: "ready",
    },
    workspaceReadOnlyReason: undefined,
    activeTaskProvider: null,
    activeTaskTitle: "",
    gitState: {
      datasets: { staged: { sections: [] }, unstaged: { sections: [] } },
      summary: { isRepository: false, headRefType: null, branchName: null },
    },
    activeTaskChangeSummary: null,
    gitWorktreeChangeSummary: { added: 0, removed: 0 },
    sidePaneState: null,
    recentClosedSidePaneTabs: [],
    browserRestoreUrls: {},
    shellPanelIds: [],
    taskSessionFile: { path: null },
    taskNativeSessionLogFile: { path: null, provider: null },
    theme: "dark",
    taskFindDialogProps: {
      open: false,
      focusRequestId: 0,
      conversationMatchCount: 0,
      conversationMatchIndex: -1,
      fileChangeMatchCount: 0,
      fileChangeMatchIndex: -1,
      onOpenChange: noop,
      onConversationFindChange: noop,
      onConversationFindNavigate: noop,
      onFileChangeFindChange: noop,
      onFileChangeFindNavigate: noop,
      onOpenFileChanges: noop,
    },
    sidebarContainerRef: { current: null },
    onCreateTask: noop,
    handleSelectTask: (_workspacePath: string, id: string) => {
      events.push(`native-navigation:${id}`);
      setActiveTaskId(id);
    },
    handleStartDraftInWorkspace: noop,
    onWorkspaceMainViewChange: noop,
    onOpenBrowserUrl: noop,
    onOpenCodeViewer: noop,
    onOpenGitReview: noop,
    onConversationFindMatchStateChange: noop,
    onFileChangeFindMatchCountChange: noop,
  } as unknown as WorkspaceShellLayoutProps;
  return (
    <main className="h-screen w-screen bg-background text-foreground text-ui-base">
      <output data-testid="shell-events">{events.join("|")}</output>
      <output data-testid="native-calls">{nativeCalls}</output>
      <output data-testid="native-subscriptions">{nativeSubscriptions}</output>
      <output data-testid="create-calls">{createCalls}</output>
      <WorkspaceShellLayout {...props} />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale="en-US">
    <PlatformProvider platform={platform}>
      <ServiceProvider services={services}>
        <StoreProvider broadcastService={services.broadcastService as never}>
          <TabStoreProvider>
            <TooltipProvider>
              <CodingPlanUpgradeDialogProvider>
                <SeededFixture />
              </CodingPlanUpgradeDialogProvider>
            </TooltipProvider>
          </TabStoreProvider>
        </StoreProvider>
      </ServiceProvider>
    </PlatformProvider>
  </ZCodeIntlProvider>,
);
