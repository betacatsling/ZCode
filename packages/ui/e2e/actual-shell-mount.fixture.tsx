/* The Shell view uses the same production desktop MessagePort service connection. No service facts
 * are supplied by this fixture: Core's Catalog/Host/hierarchy own every business row and event. */
import * as React from "react";
import { createRoot } from "react-dom/client";
import { connectViaMessagePort } from "../../client/src/index.js";
import { InternalChannels } from "@zcode/shared";
import { registerBaseWorkspaceServices } from "@zcode/ui";
import { createDesktopPlatform } from "../../desktop/src/renderer/src/desktopPlatform.js";
import { WorkspaceShellLayout } from "../src/app-shell/WorkspaceShellLayout.js";
import { ServiceProvider } from "../src/hooks/useServices.js";
import { PlatformProvider } from "../src/hooks/usePlatform.js";
import { StoreProvider } from "../src/store/StoreProvider.js";
import { TabStoreProvider, useTabStoreApi } from "../src/store/TabStoreProvider.js";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { CodingPlanUpgradeDialogProvider } from "../src/settings/CodingPlanUpgradeDialogProvider.js";
import type { WorkspaceShellLayoutProps } from "../src/app-shell/types.js";
import type { IServiceAccessor } from "@zcode/services";
import "@zcode/ui/styles.css";

const platform = createDesktopPlatform({ isLocalDevelopmentRuntime: true });
let attached = false;
window.addEventListener("message", (event) => {
  if (
    attached ||
    event.source !== window ||
    event.data?.type !== InternalChannels.ServicePort ||
    !event.ports[0]
  )
    return;
  attached = true;
  const services = connectViaMessagePort(event.ports[0]);
  registerBaseWorkspaceServices(services);
  createRoot(document.getElementById("root")!).render(
    <ZCodeIntlProvider initialLocale="en-US">
      <PlatformProvider platform={platform}>
        <ServiceProvider services={services}>
          <StoreProvider broadcastService={services.broadcastService}>
            <TabStoreProvider>
              <TooltipProvider>
                <CodingPlanUpgradeDialogProvider>
                  <MountedShell services={services} />
                </CodingPlanUpgradeDialogProvider>
              </TooltipProvider>
            </TabStoreProvider>
          </StoreProvider>
        </ServiceProvider>
      </PlatformProvider>
    </ZCodeIntlProvider>,
  );
});

function MountedShell({ services }: { services: IServiceAccessor }) {
  const tabs = useTabStoreApi();
  const [workspace, setWorkspace] = React.useState<{
    path: string;
    identity: string;
    name: string;
  } | null>(null);
  React.useEffect(() => {
    let active = true;
    void services.projectCatalogService.sidebarSnapshot().then((snapshot) => {
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
  return (
    <main className="h-screen w-screen bg-background text-foreground text-ui-base">
      <WorkspaceShellLayout {...props} />
    </main>
  );
}
