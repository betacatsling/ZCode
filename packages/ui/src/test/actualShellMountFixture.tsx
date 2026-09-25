/* The Shell view uses the same production desktop MessagePort service connection. No service facts
 * are supplied by this fixture: Core's Catalog/Host/hierarchy own every business row and event. */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { registerBaseWorkspaceServices } from "@zcode/ui";
import { WorkspaceShellLayout } from "../app-shell/WorkspaceShellLayout.js";
import { usePaneLayoutStore } from "../v4/paneLayoutStore.js";
import { ServiceProvider } from "../hooks/useServices.js";
import { PlatformProvider } from "../hooks/usePlatform.js";
import { StoreProvider } from "../store/StoreProvider.js";
import { TabStoreProvider, useTabStoreApi } from "../store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "../i18n/IntlProvider.js";
import { TooltipProvider } from "../components/ui/tooltip.js";
import { CodingPlanUpgradeDialogProvider } from "../settings/CodingPlanUpgradeDialogProvider.js";
import type { WorkspaceShellLayoutProps } from "../app-shell/types.js";
import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import "@zcode/ui/styles.css";

export function mountActualShellFixture(services: IServiceAccessor, platform: IPlatformService) {
  if (!services.projectCatalogService || !services.workspaceHierarchyService)
    throw new Error("Core Catalog and hierarchy are required for the mounted Shell");
  registerBaseWorkspaceServices(services);
  const observedHostEvents = new Map<string, { seq: number; kind: string; count: number }>();
  services.agentHostService?.onEvent(({ spec, event }) => {
    if (spec.harness.id !== "synthetic-history") return;
    const old = observedHostEvents.get(spec.hostSessionId);
    observedHostEvents.set(spec.hostSessionId, {
      seq: event.sequence,
      kind: event.kind,
      count: (old?.count ?? 0) + 1,
    });
  });
  (
    window as typeof window & { __actualShellObservedHistoryEvents?: (id: string) => unknown }
  ).__actualShellObservedHistoryEvents = (id) => observedHostEvents.get(id) ?? null;
  // Read-only observation over the *same public desktop MessagePort* as the Shell.
  // It cannot mutate Core facts, inject snapshots or alter the store's browsing cursor.
  (
    window as typeof window & { __actualShellPublicHistory?: (id: string) => Promise<unknown> }
  ).__actualShellPublicHistory = async (id) => {
    if (!services.agentHostService || !services.projectCatalogService)
      throw new Error("Mounted Host RPC missing");
    const catalog = await services.projectCatalogService.sidebarSnapshot();
    const targetId = catalog.bindings[0]?.executionTargetId;
    if (!targetId) throw new Error("Mounted Core target missing");
    const spec = await services.agentHostService.getSessionSpec({
      targetId,
      workspaceId: "main",
      hostSessionId: id,
    });
    if (!spec || spec.harness.id !== "synthetic-history")
      throw new Error("Synthetic owner not found");
    return services.agentHostService.rowsRange(spec, { sessionId: id, beforeRowId: 10, limit: 9 });
  };
  (
    window as typeof window & {
      __actualShellReadonlyJoin?: {
        createNativeSession(): Promise<string>;
        inspectNativeSelection(): Promise<unknown>;
        archiveWorkspace(): Promise<void>;
        resolveOwner(sessionId: string): Promise<unknown>;
        dispatchHostSend(sessionId: string): Promise<unknown>;
      };
    }
  ).__actualShellReadonlyJoin = {
    async createNativeSession() {
      const hierarchy = services.workspaceHierarchyService;
      if (!hierarchy || !services.projectCatalogService)
        throw new Error("Mounted Core hierarchy missing");
      const snapshot = await services.projectCatalogService.sidebarSnapshot();
      const workspace = snapshot.workspaces.find((row) => row.id === "main");
      if (!workspace) throw new Error("Mounted Core workspace missing");
      const options = await hierarchy.listCreateOptions(workspace.id);
      // 中文：选项按 Registry provider 顺序枚举，builtin 在前；若取第一个 zcode 选项，
      // Native 会被绑到 builtin chat-completions 通道，断言无法区分原生模型路由。
      // 这里必须选择与会话可用的配置默认（personal provider 的 defaultModelSelection）
      // 一致的选项，证明该默认真的能被公开 ModelSelectionService + Core owner 选中。
      const view = await services.modelSelectionService.getView();
      const preferred = view.preferredSelection;
      if (!preferred) throw new Error("Mounted Core has no configured default model selection");
      const native = options.options.find(
        (option) =>
          option.harnessId === "zcode" &&
          option.binding.kind === "host-managed" &&
          option.binding.selection.providerId === preferred.providerId &&
          option.binding.selection.modelId === preferred.modelId &&
          option.binding.selection.options?.reasoningLevel === preferred.options?.reasoningLevel,
      );
      if (!native)
        throw new Error(
          `Isolated real Native option for the configured default unavailable: ${JSON.stringify(preferred)}`,
        );
      const created = await hierarchy.createAgent({
        workspaceId: workspace.id,
        harnessId: "zcode",
        modelBinding: native.binding,
        commandId: crypto.randomUUID(),
      });
      if (created.owner.kind !== "native" || created.owner.historyOnly)
        throw new Error("Core did not return a writable original Native owner");
      const nativeOwner = created.owner;
      // 中文：Native 树行使用派生 ID，不等于真实 CLI ID；只信相同 Core 的原始 owner 证明。
      const binding = snapshot.bindings.find((row) => row.id === workspace.repositoryBindingId);
      if (!binding) throw new Error("Mounted Core Native target missing");
      const resolved = await hierarchy.resolveOwner({
        targetId: binding.executionTargetId,
        workspaceId: workspace.id,
        sessionId: nativeOwner.originalSessionId,
      });
      if (
        resolved?.kind !== "native" ||
        resolved.originalSessionId !== nativeOwner.originalSessionId ||
        resolved.historyOnly
      )
        throw new Error("Core did not resolve the original Native CLI owner");
      return nativeOwner.originalSessionId;
    },
    async inspectNativeSelection() {
      // Test-only public Host read; never inject a view or alter the renderer's selection.
      return services.modelSelectionService.getView();
    },
    async archiveWorkspace() {
      if (!services.projectCatalogService) throw new Error("Mounted Core Catalog missing");
      await services.projectCatalogService.updateWorkspace("main", { archived: true });
    },
    async resolveOwner(sessionId) {
      const hierarchy = services.workspaceHierarchyService;
      const catalogService = services.projectCatalogService;
      if (!hierarchy || !catalogService) throw new Error("Mounted Core hierarchy missing");
      const snapshot = await catalogService.sidebarSnapshot();
      const workspace = snapshot.workspaces.find((row) => row.id === "main");
      const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
      if (!workspace || !binding) throw new Error("Mounted Core workspace scope missing");
      return hierarchy.resolveOwner({
        targetId: binding.executionTargetId,
        workspaceId: workspace.id,
        sessionId,
      });
    },
    async dispatchHostSend(sessionId) {
      const hierarchy = services.workspaceHierarchyService;
      const catalogService = services.projectCatalogService;
      const host = services.agentHostService;
      if (!hierarchy || !catalogService || !host)
        throw new Error("Mounted Core Host/hierarchy missing");
      const snapshot = await catalogService.sidebarSnapshot();
      const workspace = snapshot.workspaces.find((row) => row.id === "main");
      const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
      if (!workspace || !binding) throw new Error("Mounted Core workspace scope missing");
      const owner = await hierarchy.resolveOwner({
        targetId: binding.executionTargetId,
        workspaceId: workspace.id,
        sessionId,
      });
      if (!owner || owner.kind !== "external") throw new Error("Mounted external owner missing");
      const commandId = crypto.randomUUID();
      return host.dispatch(owner.spec, {
        type: "send",
        commandId,
        hostSessionId: sessionId,
        turnId: commandId,
        text: "Must not dispatch after archive",
      });
    },
  };
  createRoot(document.getElementById("root")!).render(
    <ZCodeIntlProvider initialLocale="en-US">
      <PlatformProvider platform={platform}>
        <ServiceProvider services={services}>
          <StoreProvider broadcastService={services.broadcastService}>
            <TabStoreProvider>
              <TooltipProvider>
                <CodingPlanUpgradeDialogProvider>
                  <MountedShell services={services} platform={platform} />
                </CodingPlanUpgradeDialogProvider>
              </TooltipProvider>
            </TabStoreProvider>
          </StoreProvider>
        </ServiceProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>,
  );
}

function MountedShell({
  services,
  platform,
}: {
  services: IServiceAccessor;
  platform: IPlatformService;
}) {
  const tabs = useTabStoreApi();
  const [workspace, setWorkspace] = React.useState<{
    path: string;
    identity: string;
    name: string;
  } | null>(null);
  const [selectedNativeId, setSelectedNativeId] = React.useState<string | null>(null);
  const [splitSessionId, setSplitSessionId] = React.useState("");
  const [splitError, setSplitError] = React.useState<string | null>(null);
  React.useEffect(() => {
    let active = true;
    void services.projectCatalogService!.sidebarSnapshot().then((snapshot) => {
      const row = snapshot.workspaces[0];
      if (!active || !row) return;
      const name = snapshot.projects.find((project) => project.id === row.projectId)?.name ?? "";
      tabs.getState().addTab(row.worktreePath, { workspaceIdentity: row.workspaceIdentity });
      setWorkspace({ path: row.worktreePath, identity: row.workspaceIdentity, name });
    });
    return () => {
      active = false;
    };
  }, [services, tabs]);
  if (!workspace) return <div role="status">Waiting for Core Catalog</div>;
  const noop = () => {};
  const props = {
    services,
    platform,
    workspaceAbsPath: workspace.path,
    workspaceIdentity: workspace.identity,
    workspaceTabs: [
      {
        workspacePath: workspace.path,
        workspaceIdentity: workspace.identity,
        label: "Main checkout",
      },
    ],
    reconnectingRemoteWorkspaceKeys: [],
    remoteWorkspaceErrorByWorkspaceKey: {},
    projectName: workspace.name,
    workspaceMainView: "chat",
    isDesktop: true,
    isSidebarVisible: true,
    isBrowserOpen: false,
    isTerminalOpen: false,
    isSidePaneOpen: false,
    isGitOpen: false,
    activeTaskId: selectedNativeId,
    sidePaneOwnerId: null,
    activeSessionId: null,
    workspaceShellZCodeState: {
      activeTaskId: selectedNativeId,
      optimisticTaskListByTaskId: {},
      workspaceInit: "ready",
    },
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
    // 中文：真实 Core owner 校验后 Shell 才调用此导航回调；fixture 只保存视图焦点。
    handleSelectTask: (_path: string, originalSessionId: string) =>
      setSelectedNativeId(originalSessionId),
    handleStartDraftInWorkspace: noop,
    onWorkspaceMainViewChange: noop,
    onOpenBrowserUrl: noop,
    onOpenCodeViewer: noop,
    onOpenGitReview: noop,
    onConversationFindMatchStateChange: noop,
    onFileChangeFindMatchCountChange: noop,
  } as unknown as WorkspaceShellLayoutProps;
  const splitFirstVerifiedAgent = async () => {
    setSplitError(null);
    // View-only test command: facts and owner proof still come from the real Core;
    // the product pane store performs the split. It neither creates nor sends.
    if (!services.projectCatalogService || !services.workspaceHierarchyService)
      throw new Error("Core Catalog and hierarchy unavailable");
    const catalog = await services.projectCatalogService.sidebarSnapshot();
    const first = catalog.sessions.find(
      (row) =>
        row.session.workspaceId === "main" &&
        row.session.harnessId === "pi" &&
        row.session.id === splitSessionId,
    );
    if (!first) throw new Error("No Core Pi session to split");
    const owner = await services.workspaceHierarchyService.resolveOwner({
      targetId: catalog.bindings[0]!.executionTargetId,
      workspaceId: "main",
      sessionId: first.session.id,
    });
    if (!owner || owner.kind !== "external" || owner.historyOnly)
      throw new Error("First agent not proven writable by Core");
    usePaneLayoutStore.getState().openSessionInNewPane(
      {
        workspacePath: owner.scope.workspacePath,
        workspaceIdentity: owner.scope.workspaceIdentity,
      },
      owner.spec.hostSessionId,
    );
  };
  return (
    <main className="h-screen w-screen bg-background text-foreground text-ui-base">
      <input
        aria-label="Split session ID"
        value={splitSessionId}
        onChange={(event) => setSplitSessionId(event.target.value)}
      />
      <button
        type="button"
        onClick={() =>
          void splitFirstVerifiedAgent().catch((cause) => setSplitError(String(cause)))
        }
        data-testid="split-verified-agent"
      >
        Split verified agent view
      </button>
      {splitError && <div role="alert">{splitError}</div>}
      <WorkspaceShellLayout {...props} />
    </main>
  );
}
