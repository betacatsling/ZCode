import { create } from "zustand";

/** Window-local view preferences only. Host snapshots remain the sole owner of workspace/session facts. */
interface ProjectSidebarViewState {
  selectedSessionId?: string;
  expandedProjects: Record<string, boolean>;
  expandedWorkspaces: Record<string, boolean>;
  expandedHiddenWorkspaces: Record<string, boolean>;
  drafts: Record<string, string>;
  scrollTop: number;
  selectSession: (id: string) => void;
  setProjectExpanded: (id: string, expanded: boolean) => void;
  setWorkspaceExpanded: (id: string, expanded: boolean) => void;
  setHiddenWorkspacesExpanded: (projectId: string, expanded: boolean) => void;
  setDraft: (workspaceId: string, value: string) => void;
  setScrollTop: (value: number) => void;
}

export const useProjectSidebarViewStore = create<ProjectSidebarViewState>((set) => ({
  expandedProjects: {},
  expandedWorkspaces: {},
  expandedHiddenWorkspaces: {},
  drafts: {},
  scrollTop: 0,
  selectSession: (id) => set({ selectedSessionId: id }),
  setProjectExpanded: (id, expanded) =>
    set((s) => ({ expandedProjects: { ...s.expandedProjects, [id]: expanded } })),
  setWorkspaceExpanded: (id, expanded) =>
    set((s) => ({ expandedWorkspaces: { ...s.expandedWorkspaces, [id]: expanded } })),
  setHiddenWorkspacesExpanded: (id, expanded) =>
    set((s) => ({ expandedHiddenWorkspaces: { ...s.expandedHiddenWorkspaces, [id]: expanded } })),
  setDraft: (id, value) => set((s) => ({ drafts: { ...s.drafts, [id]: value } })),
  setScrollTop: (value) => set({ scrollTop: value }),
}));
