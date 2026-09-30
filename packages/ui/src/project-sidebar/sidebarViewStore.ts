import { createStore, type StoreApi } from "zustand/vanilla";

export interface WorkspaceCreationDraft {
  title: string;
  baseRef: string;
  branchMode: "new" | "existing";
  branch: string;
  directory: string;
}

export interface AgentCreationDraft {
  harnessId: string | null;
  modelId: string | null;
  title: string;
}

export const EMPTY_WORKSPACE_DRAFT: WorkspaceCreationDraft = {
  title: "",
  baseRef: "",
  branchMode: "new",
  branch: "",
  directory: "",
};

export const EMPTY_AGENT_DRAFT: AgentCreationDraft = {
  harnessId: null,
  modelId: null,
  title: "",
};

export interface OrcaSidebarViewData {
  expandedProjectIds: readonly string[];
  expandedWorkspaceIds: readonly string[];
  hiddenWorkspaceIds: readonly string[];
  pinnedProjectIds: readonly string[];
  projectOrder: readonly string[];
  workspaceOrder: readonly string[];
  activeSessionId: string | null;
  drafts: Readonly<Record<string, string>>;
  scrollTop: number;
  workspaceDialogProjectId: string | null;
  workspaceDraft: WorkspaceCreationDraft;
  discoveredProjectId: string | null;
  agentWorkspaceId: string | null;
  agentDraft: AgentCreationDraft;
}

export interface OrcaSidebarViewState extends OrcaSidebarViewData {
  toggleProject: (projectId: string) => void;
  toggleWorkspace: (workspaceId: string) => void;
  hideWorkspace: (workspaceId: string) => void;
  showWorkspace: (workspaceId: string) => void;
  pinProject: (projectId: string) => void;
  setProjectOrder: (projectIds: readonly string[]) => void;
  setWorkspaceOrder: (workspaceIds: readonly string[]) => void;
  selectSession: (sessionId: string) => void;
  setDraft: (key: string, value: string) => void;
  setScrollTop: (scrollTop: number) => void;
  openWorkspaceDialog: (projectId: string) => void;
  closeWorkspaceDialog: () => void;
  setWorkspaceDraft: (draft: WorkspaceCreationDraft) => void;
  openDiscovered: (projectId: string) => void;
  closeDiscovered: () => void;
  openAgentDraft: (workspaceId: string) => void;
  closeAgentDraft: () => void;
  setAgentDraft: (draft: AgentCreationDraft) => void;
}

const INITIAL_VIEW: OrcaSidebarViewData = {
  expandedProjectIds: [],
  expandedWorkspaceIds: [],
  hiddenWorkspaceIds: [],
  pinnedProjectIds: [],
  projectOrder: [],
  workspaceOrder: [],
  activeSessionId: null,
  drafts: {},
  scrollTop: 0,
  workspaceDialogProjectId: null,
  workspaceDraft: EMPTY_WORKSPACE_DRAFT,
  discoveredProjectId: null,
  agentWorkspaceId: null,
  agentDraft: EMPTY_AGENT_DRAFT,
};

function toggle(values: readonly string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

/**
 * 视图状态只记录用户的展开、排序、选中、草稿和滚动。
 * 这里没有接收快照的方法：后台状态更新不能改焦点或选中会话。
 */
export function createOrcaSidebarViewStore(
  initial?: Partial<OrcaSidebarViewData>,
): StoreApi<OrcaSidebarViewState> {
  return createStore<OrcaSidebarViewState>()((set) => ({
    ...INITIAL_VIEW,
    ...initial,
    toggleProject: (projectId) =>
      set((state) => ({ expandedProjectIds: toggle(state.expandedProjectIds, projectId) })),
    toggleWorkspace: (workspaceId) =>
      set((state) => ({ expandedWorkspaceIds: toggle(state.expandedWorkspaceIds, workspaceId) })),
    hideWorkspace: (workspaceId) =>
      set((state) => ({
        hiddenWorkspaceIds: state.hiddenWorkspaceIds.includes(workspaceId)
          ? state.hiddenWorkspaceIds
          : [...state.hiddenWorkspaceIds, workspaceId],
      })),
    showWorkspace: (workspaceId) =>
      set((state) => ({
        hiddenWorkspaceIds: state.hiddenWorkspaceIds.filter((id) => id !== workspaceId),
      })),
    pinProject: (projectId) =>
      set((state) => ({
        pinnedProjectIds: state.pinnedProjectIds.includes(projectId)
          ? state.pinnedProjectIds.filter((id) => id !== projectId)
          : [...state.pinnedProjectIds, projectId],
      })),
    setProjectOrder: (projectOrder) => set({ projectOrder }),
    setWorkspaceOrder: (workspaceOrder) => set({ workspaceOrder }),
    selectSession: (activeSessionId) => set({ activeSessionId }),
    setDraft: (key, value) => set((state) => ({ drafts: { ...state.drafts, [key]: value } })),
    setScrollTop: (scrollTop) => set({ scrollTop }),
    openWorkspaceDialog: (workspaceDialogProjectId) => set({ workspaceDialogProjectId }),
    closeWorkspaceDialog: () => set({ workspaceDialogProjectId: null }),
    setWorkspaceDraft: (workspaceDraft) => set({ workspaceDraft }),
    openDiscovered: (discoveredProjectId) => set({ discoveredProjectId }),
    closeDiscovered: () => set({ discoveredProjectId: null }),
    openAgentDraft: (agentWorkspaceId) => set({ agentWorkspaceId, agentDraft: EMPTY_AGENT_DRAFT }),
    closeAgentDraft: () => set({ agentWorkspaceId: null, agentDraft: EMPTY_AGENT_DRAFT }),
    setAgentDraft: (agentDraft) => set({ agentDraft }),
  }));
}

export function orderByIds<T extends { id: string }>(
  entities: readonly T[],
  manualOrder: readonly string[],
  pinnedIds: readonly string[] = [],
): T[] {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const used = new Set<string>();
  const ordered: T[] = [];
  const push = (id: string) => {
    const entity = byId.get(id);
    if (!entity || used.has(id)) return;
    used.add(id);
    ordered.push(entity);
  };
  for (const id of pinnedIds) push(id);
  for (const id of manualOrder) push(id);
  for (const entity of entities) push(entity.id);
  return ordered;
}
