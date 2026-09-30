import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService, RemoteTarget } from "@zcode/shared";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { IProjectCatalogService } from "@zcode/services/project-catalog";
import type { IWorktreeService } from "@zcode/services/worktree";
import type {
  AgentHostSessionSummary,
  HarnessDirectorySnapshot,
  SessionHierarchyFile,
} from "@zcode/shared/agent-host";
import type { AgentHostConversationAttachment } from "../../src/v4/agentHostConversationOwner.js";
import { ZCodeIntlProvider } from "../../src/i18n/IntlProvider.js";
import { ServiceProvider } from "../../src/hooks/useServices.js";
import { PlatformProvider } from "../../src/hooks/usePlatform.js";
import { TooltipProvider } from "../../src/components/ui/tooltip.js";
import { ProjectSidebarMount } from "../../src/project-sidebar/ProjectSidebarMount.js";
import { TabStoreProvider } from "../../src/store/TabStoreProvider.js";
import {
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "../../src/store/remoteWorkspaceSessionStore.js";
import { useProjectSidebarViewStore } from "../../src/store/projectSidebarViewStore.js";
import "../../src/styles.css";

interface DriverHealth {
  targetIds: readonly string[];
  repoPath: string;
  barePath: string;
  emptyBarePath: string;
  root: string;
  gitVersion: string;
}

interface DriverState {
  catalog: Awaited<ReturnType<IProjectCatalogService["read"]>>;
  worktrees: Record<string, Awaited<ReturnType<IWorktreeService["read"]>>>;
  counters: {
    catalogReads: number;
    catalogIngests: number;
    worktreeReadsByTarget: Record<string, number>;
    gitVersion: string;
  };
  offlineTargets: string[];
  heldReads: Array<{ targetId: string; started: boolean; released: boolean }>;
}

const driverHealth = await fetch("/__project-sidebar/health").then(
  (response) => response.json() as Promise<DriverHealth>,
);
const locale =
  new URLSearchParams(window.location.search).get("locale") === "zh-CN" ? "zh-CN" : "en-US";
const targetAlpha = driverHealth.targetIds[0]!;
const initialTargetIds = driverHealth.targetIds.slice(0, 3);
const remoteTargetById = new Map<string, RemoteTarget>(
  driverHealth.targetIds.map((targetId) => [
    targetId,
    { kind: "docker", container: `sidebar-${targetId}` },
  ]),
);

async function post<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = (await response.json()) as T | { error: string };
  if (!response.ok) throw new Error("error" in result ? result.error : `HTTP ${response.status}`);
  return result as T;
}

function catalogRpc<T>(method: string, args: unknown = {}): Promise<T> {
  return post<T>(`/__project-sidebar/rpc/catalog/${method}`, args);
}

function worktreeRpc<T>(targetId: string, method: string, args: unknown = {}): Promise<T> {
  return post<T>(`/__project-sidebar/rpc/worktree/${method}`, {
    targetId,
    ...((args ?? {}) as object),
  });
}

function createTargetServices(targetId: string): IServiceAccessor {
  const target = remoteTargetById.get(targetId)!;
  const worktreeService = {
    getAvailability: () => worktreeRpc(targetId, "getAvailability"),
    read: () => worktreeRpc(targetId, "read"),
    discover: (inputPath: string) => worktreeRpc(targetId, "discover", { inputPath }),
    adopt: (projectId: string, candidate: unknown, title?: string) =>
      worktreeRpc(targetId, "adopt", { projectId, candidate, title }),
    adoptBareRepository: (projectId: string, request: unknown) =>
      worktreeRpc(targetId, "adoptBareRepository", { projectId, request }),
    createWorkspace: (request: unknown) => worktreeRpc(targetId, "createWorkspace", { request }),
    updateWorkspace: (request: unknown) => worktreeRpc(targetId, "updateWorkspace", { request }),
    revalidate: (workspaceId: string, options?: unknown) =>
      worktreeRpc(targetId, "revalidate", { workspaceId, options }),
  } as unknown as IWorktreeService;
  const agentHostService = {
    async getDirectory() {
      const response = await fetch(`/__project-sidebar/rpc/directory/${targetId}`);
      const result = (await response.json()) as HarnessDirectorySnapshot | { error: string };
      if (!response.ok)
        throw new Error(
          "error" in result ? result.error : `Directory request failed: ${response.status}`,
        );
      return result as HarnessDirectorySnapshot;
    },
    listSessionSummaries(workspaceIdentity: string, worktreePath: string) {
      return post<AgentHostSessionSummary[]>("/__project-sidebar/rpc/summaries", {
        targetId,
        workspaceIdentity,
        worktreePath,
      });
    },
    onEvent() {
      return { dispose() {} };
    },
  };
  const sessionHierarchyService = {
    async read() {
      const response = await fetch(`/__project-sidebar/rpc/hierarchy/${targetId}`);
      if (!response.ok) throw new Error(`Hierarchy request failed: ${response.status}`);
      return (await response.json()) as SessionHierarchyFile;
    },
    preview() {
      return this.read();
    },
  };
  const zcodeTaskService = {
    async listTasks() {
      return [];
    },
  };
  return {
    worktreeService,
    agentHostService,
    sessionHierarchyService,
    zcodeTaskService,
    remoteTarget: target,
  } as unknown as IServiceAccessor;
}

const profileServices = {
  projectCatalogService: {
    read: () => catalogRpc("read"),
    readWorkspaceCatalog: (targetConnections?: unknown) =>
      catalogRpc("readWorkspaceCatalog", { targetConnections }),
    createProject: (input: unknown) => catalogRpc("createProject", { input }),
    updateProject: (id: string, patch: unknown) => catalogRpc("updateProject", { id, patch }),
    setWorkspaceRefs: (
      id: string,
      workspaceIds: readonly string[],
      defaultWorkspaceId?: string | null,
    ) => catalogRpc("setWorkspaceRefs", { id, workspaceIds, defaultWorkspaceId }),
    setDefaultWorkspaceRef: (id: string, reference: unknown) =>
      catalogRpc("setDefaultWorkspaceRef", { id, reference }),
    ingestTargetSnapshot: (snapshot: unknown) => catalogRpc("ingestTargetSnapshot", { snapshot }),
    markTargetFreshness: (targetId: string, freshness: string, observedAt: number) =>
      catalogRpc("markTargetFreshness", { targetId, freshness, observedAt }),
  } as unknown as IProjectCatalogService,
} as unknown as IServiceAccessor;

const targetServices = new Map(
  driverHealth.targetIds.map((targetId) => [targetId, createTargetServices(targetId)]),
);
let generationByTarget = new Map<string, number>();

function remoteSessionId(targetId: string): string {
  const generation = generationByTarget.get(targetId) ?? 1;
  return `sidebar-attachment-${targetId}-${generation}`;
}

function attachTarget(targetId: string, sessionId = remoteSessionId(targetId)): void {
  registerRemoteWorkspaceSession({
    sessionId,
    target: remoteTargetById.get(targetId),
    services: targetServices.get(targetId)!,
  });
}

const fixturePlatform = new Proxy(Object.create(null) as Record<string, unknown>, {
  get(_target, property) {
    const method = String(property);
    if (method.startsWith("on")) return () => () => {};
    return async () => undefined;
  },
}) as unknown as IPlatformService;

declare global {
  interface Window {
    __projectSidebarMultiTarget: {
      driverHealth: DriverHealth;
      attachments(): Array<{ sessionId: string; generation: number }>;
      state(): Promise<DriverState>;
      setOffline(targetId: string, offline: boolean): Promise<void>;
      setHostUnsupported(targetId: string, unsupported: boolean): Promise<void>;
      failNextCatalogWrite(): Promise<void>;
      seedSessions(projectId: string, sessionId?: string): Promise<void>;
      holdRead(targetId: string): Promise<string>;
      releaseRead(holdId: string): Promise<void>;
      rename(targetId: string, workspaceId: string, title: string): Promise<void>;
      reconnect(targetId: string): void;
      replaceTarget(oldTargetId: string, newTargetId: string): void;
      viewState(): Record<string, unknown>;
      showWorkspace(targetId: string, workspaceId: string): void;
      selectedRoutes(): Array<Record<string, unknown>>;
      reconnectFlowOpened(): boolean;
      setLocale(locale: "en-US" | "zh-CN"): void;
    };
  }
}

function MultiTargetFixture() {
  const [workspacePath] = useState(driverHealth.repoPath);
  const [activeRemoteSessionId, setActiveRemoteSessionId] = useState(remoteSessionId(targetAlpha));
  const [selectedRoutes, setSelectedRoutes] = useState<Array<Record<string, unknown>>>([]);
  const [reconnectOpened, setReconnectOpened] = useState(false);
  const [activeLocale, setActiveLocale] = useState(locale);
  const [, setRevision] = useState(0);
  const routesRef = useRef(selectedRoutes);
  routesRef.current = selectedRoutes;
  const attachedSessionIdsRef = useRef(
    new Map(initialTargetIds.map((targetId) => [targetId, remoteSessionId(targetId)])),
  );
  const appServices = useMemo(() => profileServices, []);

  useEffect(() => {
    registerBaseWorkspaceServices(appServices);
  }, [appServices]);

  useEffect(() => {
    for (const [targetId, sessionId] of attachedSessionIdsRef.current)
      attachTarget(targetId, sessionId);
    return () => {
      for (const sessionId of attachedSessionIdsRef.current.values()) {
        unregisterRemoteWorkspaceSession(sessionId);
      }
    };
  }, []);

  const api = useMemo(() => {
    const fixtureApi = {
      driverHealth,
      attachments() {
        return Object.values(useRemoteWorkspaceSessionStore.getState().sessionsById).map(
          (session) => ({
            sessionId: session.sessionId,
            generation: session.attachmentGeneration,
          }),
        );
      },
      async state() {
        const response = await fetch("/__project-sidebar/state");
        return (await response.json()) as DriverState;
      },
      async setOffline(targetId: string, offline: boolean) {
        await post("/__project-sidebar/control/offline", { targetId, offline });
        setRevision((value) => value + 1);
      },
      async setHostUnsupported(targetId: string, unsupported: boolean) {
        await post("/__project-sidebar/control/unsupported-host", { targetId, unsupported });
        setRevision((value) => value + 1);
      },
      async failNextCatalogWrite() {
        await post("/__project-sidebar/control/fail-next-catalog-write", {});
      },
      async seedSessions(projectId: string, sessionId = "same-session") {
        await post("/__project-sidebar/control/seed-sessions", { projectId, sessionId });
        setRevision((value) => value + 1);
      },
      async holdRead(targetId: string) {
        const result = await post<{ holdId: string }>("/__project-sidebar/control/hold-next-read", {
          targetId,
        });
        return result.holdId;
      },
      async releaseRead(holdId: string) {
        await post("/__project-sidebar/control/release-read", { holdId });
      },
      async rename(targetId: string, workspaceId: string, title: string) {
        await post("/__project-sidebar/control/rename", { targetId, workspaceId, title });
      },
      reconnect(targetId: string) {
        const previousSessionId = attachedSessionIdsRef.current.get(targetId);
        if (previousSessionId) unregisterRemoteWorkspaceSession(previousSessionId);
        generationByTarget.set(targetId, (generationByTarget.get(targetId) ?? 1) + 1);
        const nextSessionId = remoteSessionId(targetId);
        attachedSessionIdsRef.current.set(targetId, nextSessionId);
        attachTarget(targetId, nextSessionId);
        if (targetId === targetAlpha) setActiveRemoteSessionId(nextSessionId);
        setRevision((value) => value + 1);
      },
      replaceTarget(oldTargetId: string, newTargetId: string) {
        const previousSessionId = attachedSessionIdsRef.current.get(oldTargetId);
        if (previousSessionId) unregisterRemoteWorkspaceSession(previousSessionId);
        attachedSessionIdsRef.current.delete(oldTargetId);
        generationByTarget.set(newTargetId, (generationByTarget.get(newTargetId) ?? 1) + 1);
        const nextSessionId = remoteSessionId(newTargetId);
        attachedSessionIdsRef.current.set(newTargetId, nextSessionId);
        attachTarget(newTargetId, nextSessionId);
        setRevision((value) => value + 1);
      },
      viewState() {
        const state = useProjectSidebarViewStore.getState();
        return {
          expandedProjectIds: [...state.expandedProjectIds],
          expandedWorkspaceKeys: [...state.expandedWorkspaceKeys],
          hiddenWorkspaceKeys: [...state.hiddenWorkspaceKeys],
          activeProjectId: state.activeProjectId,
          activeWorkspaceKey: state.activeWorkspaceKey,
          activeSessionKey: state.activeSessionKey,
        };
      },
      showWorkspace(targetId: string, workspaceId: string) {
        useProjectSidebarViewStore.getState().showWorkspace(targetId, workspaceId);
      },
      selectedRoutes() {
        return [...routesRef.current];
      },
      reconnectFlowOpened() {
        return reconnectOpened;
      },
      setLocale(nextLocale: "en-US" | "zh-CN") {
        setActiveLocale(nextLocale);
      },
    };
    window.__projectSidebarMultiTarget = fixtureApi;
    return fixtureApi;
  }, [reconnectOpened]);
  void api;

  return (
    <ZCodeIntlProvider initialLocale={activeLocale}>
      <TooltipProvider>
        <PlatformProvider platform={fixturePlatform}>
          <ServiceProvider services={appServices}>
            <TabStoreProvider>
              <main className="flex h-full w-full flex-col bg-background text-foreground">
                <header className="border-b border-border p-2 text-ui-sm">
                  Real file Catalog and temporary Git services: {driverHealth.gitVersion}
                </header>
                <div className="max-h-[90vh] w-[380px] overflow-y-auto">
                  <ProjectSidebarMount
                    workspacePath={workspacePath}
                    workspaceIdentity={buildRemoteWorkspaceIdentity(
                      workspacePath,
                      remoteTargetById.get(targetAlpha)!,
                    )}
                    workspaceRemoteSessionId={activeRemoteSessionId}
                    theme="light"
                    fallback={
                      <div data-legacy-workspace>
                        <div data-legacy-history-session="non-git">Non-Git legacy task history</div>
                        <div data-legacy-history-session="old-host">
                          Old Host legacy task history
                        </div>
                      </div>
                    }
                    onSelectTask={(
                      path,
                      sessionId,
                      identity,
                      selectedRemoteSessionId,
                      targetId,
                    ) => {
                      setSelectedRoutes((routes) => [
                        ...routes,
                        {
                          kind: "native",
                          path,
                          sessionId,
                          identity,
                          selectedRemoteSessionId,
                          targetId,
                        },
                      ]);
                    }}
                    onSelectExternalSession={(selection: AgentHostConversationAttachment) => {
                      setSelectedRoutes((routes) => [
                        ...routes,
                        {
                          kind: "agent-host",
                          targetId: selection.sessionSpec.execution.targetId,
                          sessionId: selection.sessionSpec.hostSessionId,
                          remoteSessionId: selection.remoteSessionId,
                        },
                      ]);
                    }}
                    onStartDraft={(path, identity, selectedRemoteSessionId) => {
                      setSelectedRoutes((routes) => [
                        ...routes,
                        { kind: "draft", path, identity, remoteSessionId: selectedRemoteSessionId },
                      ]);
                    }}
                    onReconnectTarget={() => setReconnectOpened(true)}
                  />
                </div>
                <output data-active-remote-session={activeRemoteSessionId} className="sr-only" />
                <output data-locale={activeLocale} className="sr-only" />
              </main>
            </TabStoreProvider>
          </ServiceProvider>
        </PlatformProvider>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}

createRoot(document.getElementById("root")!).render(<MultiTargetFixture />);
