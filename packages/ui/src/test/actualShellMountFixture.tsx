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
    activeTaskId: null,
    sidePaneOwnerId: null,
    activeSessionId: null,
    workspaceShellZCodeState: {
      activeTaskId: null,
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
    handleSelectTask: noop,
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
