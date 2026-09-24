import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

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

type ProjectSidebarViewPreferences = Pick<
  ProjectSidebarViewState,
  | "selectedSessionId"
  | "expandedProjects"
  | "expandedWorkspaces"
  | "expandedHiddenWorkspaces"
  | "drafts"
  | "scrollTop"
>;
const storage = createJSONStorage<ProjectSidebarViewPreferences>(() => localStorage);

export const useProjectSidebarViewStore = create<ProjectSidebarViewState>()(
  persist<ProjectSidebarViewState, [], [], ProjectSidebarViewPreferences>(
    (set) => ({
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
        set((s) => ({
          expandedHiddenWorkspaces: { ...s.expandedHiddenWorkspaces, [id]: expanded },
        })),
      setDraft: (id, value) => set((s) => ({ drafts: { ...s.drafts, [id]: value } })),
      setScrollTop: (value) => set({ scrollTop: value }),
    }),
    {
      name: "zcode:project-sidebar:view:v1",
      storage,
      // 修复侧栏只在内存保存折叠/草稿的问题：持久化仅 UI 偏好，绝不序列化 Host 活动或快照。
      partialize: (state) => ({
        selectedSessionId: state.selectedSessionId,
        expandedProjects: state.expandedProjects,
        expandedWorkspaces: state.expandedWorkspaces,
        expandedHiddenWorkspaces: state.expandedHiddenWorkspaces,
        drafts: state.drafts,
        scrollTop: state.scrollTop,
      }),
    },
  ),
);
