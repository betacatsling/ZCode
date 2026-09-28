import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  projectSidebarSessionViewKey,
  projectSidebarWorkspaceViewKey,
} from "@/project-sidebar/viewKeys.js";

interface LegacyWorkspaceViewState {
  expandedWorkspaceIds?: string[];
  hiddenWorkspaceIds?: string[];
  activeWorkspaceId?: string | null;
  activeSessionId?: string | null;
}

export interface ProjectSidebarWorkspaceScope {
  targetId: string | null;
  workspaceId: string;
  sessionIds: readonly string[];
}

interface ProjectSidebarViewState {
  expandedProjectIds: string[];
  expandedWorkspaceKeys: string[];
  hiddenWorkspaceKeys: string[];
  activeProjectId: string | null;
  activeWorkspaceKey: string | null;
  activeSessionKey: string | null;
  legacyWorkspaceState: LegacyWorkspaceViewState | null;
  toggleProject(projectId: string): void;
  toggleWorkspace(targetId: string | null, workspaceId: string): void;
  hideWorkspace(targetId: string | null, workspaceId: string): void;
  showWorkspace(targetId: string | null, workspaceId: string): void;
  revealWorkspace(projectId: string, targetId: string | null, workspaceId: string): void;
  selectProject(projectId: string): void;
  selectWorkspace(projectId: string, targetId: string | null, workspaceId: string): void;
  selectSession(
    projectId: string,
    targetId: string | null,
    workspaceId: string,
    sessionId: string,
  ): void;
  resolveLegacyWorkspaceState(scopes: readonly ProjectSidebarWorkspaceScope[]): void;
}

type PersistedProjectSidebarViewState = Pick<
  ProjectSidebarViewState,
  | "expandedProjectIds"
  | "expandedWorkspaceKeys"
  | "hiddenWorkspaceKeys"
  | "activeProjectId"
  | "activeWorkspaceKey"
  | "activeSessionKey"
  | "legacyWorkspaceState"
>;

function toggle(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

function migratePersistedViewState(
  persisted: unknown,
  version: number,
): PersistedProjectSidebarViewState {
  const state =
    persisted && typeof persisted === "object" ? (persisted as Record<string, unknown>) : {};
  if (version >= 2) {
    return {
      expandedProjectIds: Array.isArray(state.expandedProjectIds)
        ? state.expandedProjectIds.filter((id): id is string => typeof id === "string")
        : [],
      expandedWorkspaceKeys: Array.isArray(state.expandedWorkspaceKeys)
        ? state.expandedWorkspaceKeys.filter((key): key is string => typeof key === "string")
        : [],
      hiddenWorkspaceKeys: Array.isArray(state.hiddenWorkspaceKeys)
        ? state.hiddenWorkspaceKeys.filter((key): key is string => typeof key === "string")
        : [],
      activeProjectId: typeof state.activeProjectId === "string" ? state.activeProjectId : null,
      activeWorkspaceKey:
        typeof state.activeWorkspaceKey === "string" ? state.activeWorkspaceKey : null,
      activeSessionKey: typeof state.activeSessionKey === "string" ? state.activeSessionKey : null,
      legacyWorkspaceState:
        state.legacyWorkspaceState && typeof state.legacyWorkspaceState === "object"
          ? (state.legacyWorkspaceState as LegacyWorkspaceViewState)
          : null,
    };
  }
  return {
    expandedProjectIds: Array.isArray(state.expandedProjectIds)
      ? state.expandedProjectIds.filter((id): id is string => typeof id === "string")
      : [],
    expandedWorkspaceKeys: [],
    hiddenWorkspaceKeys: [],
    activeProjectId: typeof state.activeProjectId === "string" ? state.activeProjectId : null,
    activeWorkspaceKey: null,
    activeSessionKey: null,
    legacyWorkspaceState: {
      expandedWorkspaceIds: Array.isArray(state.expandedWorkspaceIds)
        ? state.expandedWorkspaceIds.filter((id): id is string => typeof id === "string")
        : [],
      hiddenWorkspaceIds: Array.isArray(state.hiddenWorkspaceIds)
        ? state.hiddenWorkspaceIds.filter((id): id is string => typeof id === "string")
        : [],
      activeWorkspaceId:
        typeof state.activeWorkspaceId === "string" ? state.activeWorkspaceId : null,
      activeSessionId: typeof state.activeSessionId === "string" ? state.activeSessionId : null,
    },
  };
}

export const useProjectSidebarViewStore = create<ProjectSidebarViewState>()(
  persist(
    (set) => ({
      expandedProjectIds: [],
      expandedWorkspaceKeys: [],
      hiddenWorkspaceKeys: [],
      activeProjectId: null,
      activeWorkspaceKey: null,
      activeSessionKey: null,
      legacyWorkspaceState: null,
      toggleProject: (projectId) =>
        set((state) => ({ expandedProjectIds: toggle(state.expandedProjectIds, projectId) })),
      toggleWorkspace: (targetId, workspaceId) => {
        const key = projectSidebarWorkspaceViewKey(targetId, workspaceId);
        set((state) => ({ expandedWorkspaceKeys: toggle(state.expandedWorkspaceKeys, key) }));
      },
      hideWorkspace: (targetId, workspaceId) => {
        const key = projectSidebarWorkspaceViewKey(targetId, workspaceId);
        set((state) => ({
          hiddenWorkspaceKeys: state.hiddenWorkspaceKeys.includes(key)
            ? state.hiddenWorkspaceKeys
            : [...state.hiddenWorkspaceKeys, key],
        }));
      },
      showWorkspace: (targetId, workspaceId) => {
        const key = projectSidebarWorkspaceViewKey(targetId, workspaceId);
        set((state) => ({
          hiddenWorkspaceKeys: state.hiddenWorkspaceKeys.filter((item) => item !== key),
        }));
      },
      revealWorkspace: (projectId, targetId, workspaceId) => {
        const key = projectSidebarWorkspaceViewKey(targetId, workspaceId);
        set((state) => ({
          expandedProjectIds: state.expandedProjectIds.includes(projectId)
            ? state.expandedProjectIds
            : [...state.expandedProjectIds, projectId],
          expandedWorkspaceKeys: state.expandedWorkspaceKeys.includes(key)
            ? state.expandedWorkspaceKeys
            : [...state.expandedWorkspaceKeys, key],
          hiddenWorkspaceKeys: state.hiddenWorkspaceKeys.filter((item) => item !== key),
        }));
      },
      selectProject: (projectId) =>
        set({ activeProjectId: projectId, activeWorkspaceKey: null, activeSessionKey: null }),
      selectWorkspace: (projectId, targetId, workspaceId) =>
        set({
          activeProjectId: projectId,
          activeWorkspaceKey: projectSidebarWorkspaceViewKey(targetId, workspaceId),
          activeSessionKey: null,
        }),
      selectSession: (projectId, targetId, workspaceId, sessionId) =>
        set({
          activeProjectId: projectId,
          activeWorkspaceKey: projectSidebarWorkspaceViewKey(targetId, workspaceId),
          activeSessionKey: projectSidebarSessionViewKey(targetId, workspaceId, sessionId),
        }),
      resolveLegacyWorkspaceState: (scopes) =>
        set((state) => {
          const legacy = state.legacyWorkspaceState;
          if (!legacy) return state;
          const scopesById = new Map<string, ProjectSidebarWorkspaceScope[]>();
          for (const scope of scopes) {
            const existing = scopesById.get(scope.workspaceId) ?? [];
            existing.push(scope);
            scopesById.set(scope.workspaceId, existing);
          }
          const uniqueScope = (workspaceId?: string | null) => {
            if (!workspaceId) return undefined;
            const matches = scopesById.get(workspaceId) ?? [];
            return matches.length === 1 ? matches[0] : undefined;
          };
          const expandedWorkspaceKeys = new Set(state.expandedWorkspaceKeys);
          for (const id of legacy.expandedWorkspaceIds ?? []) {
            const scope = uniqueScope(id);
            if (scope)
              expandedWorkspaceKeys.add(projectSidebarWorkspaceViewKey(scope.targetId, id));
          }
          const hiddenWorkspaceKeys = new Set(state.hiddenWorkspaceKeys);
          for (const id of legacy.hiddenWorkspaceIds ?? []) {
            const scope = uniqueScope(id);
            if (scope) hiddenWorkspaceKeys.add(projectSidebarWorkspaceViewKey(scope.targetId, id));
          }
          const activeWorkspace = uniqueScope(legacy.activeWorkspaceId);
          const activeSession = activeWorkspace?.sessionIds.includes(legacy.activeSessionId ?? "")
            ? legacy.activeSessionId
            : null;
          return {
            expandedWorkspaceKeys: [...expandedWorkspaceKeys],
            hiddenWorkspaceKeys: [...hiddenWorkspaceKeys],
            activeWorkspaceKey: activeWorkspace
              ? projectSidebarWorkspaceViewKey(
                  activeWorkspace.targetId,
                  activeWorkspace.workspaceId,
                )
              : state.activeWorkspaceKey,
            activeSessionKey:
              activeWorkspace && activeSession
                ? projectSidebarSessionViewKey(
                    activeWorkspace.targetId,
                    activeWorkspace.workspaceId,
                    activeSession,
                  )
                : state.activeSessionKey,
            legacyWorkspaceState: null,
          };
        }),
    }),
    {
      name: "zcode:project-sidebar-view:v1",
      version: 2,
      migrate: migratePersistedViewState,
      partialize: (state) => ({
        expandedProjectIds: state.expandedProjectIds,
        expandedWorkspaceKeys: state.expandedWorkspaceKeys,
        hiddenWorkspaceKeys: state.hiddenWorkspaceKeys,
        activeProjectId: state.activeProjectId,
        activeWorkspaceKey: state.activeWorkspaceKey,
        activeSessionKey: state.activeSessionKey,
        legacyWorkspaceState: state.legacyWorkspaceState,
      }),
    },
  ),
);
