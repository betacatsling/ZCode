import type { HarnessDirectoryEntry } from "@/agent-host/HarnessIcon.js";
import type { ModelBindingOption } from "@/agent-host/ModelBindingSelector.js";
import type { SidebarSnapshot } from "./planTypes.js";
import { EMPTY_AGENT_DRAFT, EMPTY_WORKSPACE_DRAFT, type OrcaSidebarViewData } from "./sidebarViewStore.js";

export const orcaSidebarNow = 1_700_000_000_000;

const minute = 60_000;

function svgAsset(mark: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="4" data-mark="${mark}"/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export const orcaHarnessDirectory: readonly HarnessDirectoryEntry[] = [
  {
    harnessId: "pi",
    name: "Pi",
    lightAssetId: "pi-light",
    darkAssetId: "pi-dark",
    fallback: "initials",
  },
  {
    harnessId: "codex",
    name: "Codex",
    lightAssetId: "codex-light",
    darkAssetId: "codex-dark",
    fallback: "generic",
  },
  {
    harnessId: "decoy-model-name",
    name: "glm-4.6",
    lightAssetId: "decoy-light",
    darkAssetId: "decoy-dark",
    fallback: "initials",
  },
];

export const orcaHarnessAssets: Readonly<Record<string, string>> = {
  "pi-light": svgAsset("pi"),
  "pi-dark": svgAsset("pi-dark"),
  "codex-light": svgAsset("codex"),
  "codex-dark": svgAsset("codex-dark"),
  "decoy-light": svgAsset("decoy"),
  "decoy-dark": svgAsset("decoy-dark"),
};

export const orcaModelOptions: readonly ModelBindingOption[] = [
  { id: "glm-4.6", label: "glm-4.6", kind: "host-managed" },
  { id: "claude-sonnet", label: "claude-sonnet", kind: "host-managed" },
  { id: "gpt-5.4", label: "gpt-5.4", kind: "harness-managed" },
];

/** 两个项目，每个至少两个工作区；适配工作区有三个会话，其中两个同为 Pi。 */
export const orcaSidebarSnapshot: SidebarSnapshot = {
  projects: [
    {
      project: {
        id: "project-zcode",
        name: "ZCode",
        defaultWorkspaceId: "ws-feature",
      },
      repositoryBinding: {
        id: "binding-zcode",
        projectId: "project-zcode",
        executionTargetId: "local-mac",
        gitCommonDir: "/repos/zcode/.git",
      },
      hiddenDiscoveredCount: 2,
      workspaces: [
        {
          workspace: {
            id: "ws-main",
            projectId: "project-zcode",
            repositoryBindingId: "binding-zcode",
            title: "主工作区",
            worktreePath: "/repos/zcode",
            worktreeGeneration: "gen-main",
            isMainWorktree: true,
            head: { kind: "branch", ref: "develop", oid: "abc123def456" },
            origin: "adopted",
            lifecycle: "active",
          },
          targetLabel: "Local Mac",
          sessions: [],
        },
        {
          workspace: {
            id: "ws-feature",
            projectId: "project-zcode",
            repositoryBindingId: "binding-zcode",
            title: "适配工作区",
            worktreePath: "/repos/zcode-feature",
            worktreeGeneration: "gen-feature",
            isMainWorktree: false,
            head: { kind: "branch", ref: "feature/sidebar", oid: "fff000aaa111" },
            origin: "created",
            lifecycle: "active",
          },
          targetLabel: "Local Mac",
          sessions: [
            {
              session: {
                id: "s-research",
                workspaceId: "ws-feature",
                harnessId: "pi",
                title: "调研适配接口",
              },
              activity: "waiting",
              freshness: "live",
              recentOutcome: "none",
              unread: false,
              pendingInteractionCount: 1,
              updatedAt: orcaSidebarNow - 3 * minute,
              modelLabel: "glm-4.6",
            },
            {
              session: {
                id: "s-session",
                workspaceId: "ws-feature",
                harnessId: "pi",
                title: "实现会话管理",
              },
              activity: "running",
              freshness: "live",
              recentOutcome: "none",
              unread: false,
              pendingInteractionCount: 0,
              updatedAt: orcaSidebarNow - minute,
              modelLabel: "claude-sonnet",
            },
            {
              session: {
                id: "s-review",
                workspaceId: "ws-feature",
                harnessId: "codex",
                title: "审阅当前变更",
              },
              activity: "running",
              freshness: "live",
              recentOutcome: "none",
              unread: false,
              pendingInteractionCount: 0,
              updatedAt: orcaSidebarNow - 9 * minute,
              modelLabel: "gpt-5.4",
            },
          ],
        },
      ],
    },
    {
      project: {
        id: "project-docs",
        name: "Docs",
        defaultWorkspaceId: "ws-docs-main",
      },
      repositoryBinding: {
        id: "binding-docs",
        projectId: "project-docs",
        executionTargetId: "server1",
        gitCommonDir: "/srv/docs/.git",
      },
      hiddenDiscoveredCount: 1,
      workspaces: [
        {
          workspace: {
            id: "ws-docs-main",
            projectId: "project-docs",
            repositoryBindingId: "binding-docs",
            title: "文档主检出",
            worktreePath: "/srv/docs",
            worktreeGeneration: "gen-docs-main",
            isMainWorktree: true,
            head: { kind: "branch", ref: "master", oid: "111aaa222bbb" },
            origin: "adopted",
            lifecycle: "active",
          },
          targetLabel: "server1",
          sessions: [
            {
              session: {
                id: "s-docs-offline",
                workspaceId: "ws-docs-main",
                harnessId: "codex",
                title: "离线后的文档",
              },
              activity: "idle",
              freshness: "offline",
              recentOutcome: "succeeded",
              unread: false,
              pendingInteractionCount: 0,
              updatedAt: orcaSidebarNow - 20 * minute,
              modelLabel: "gpt-5.4",
            },
          ],
        },
        {
          workspace: {
            id: "ws-docs-branch",
            projectId: "project-docs",
            repositoryBindingId: "binding-docs",
            title: "分支名碰巧叫 main",
            worktreePath: "/srv/docs-main-name",
            worktreeGeneration: "gen-docs-branch",
            isMainWorktree: false,
            head: { kind: "branch", ref: "main", oid: "999ccc888ddd" },
            origin: "created",
            lifecycle: "active",
          },
          targetLabel: "server1",
          sessions: [
            {
              session: {
                id: "s-docs-unknown",
                workspaceId: "ws-docs-branch",
                harnessId: "new-harness",
                title: "未知目录会话",
              },
              activity: "idle",
              freshness: "stale",
              recentOutcome: "none",
              unread: true,
              pendingInteractionCount: 1,
              updatedAt: orcaSidebarNow - 2 * minute,
              modelLabel: "GLM-4",
            },
          ],
        },
      ],
    },
  ],
};

export const orcaSidebarView: OrcaSidebarViewData = {
  expandedProjectIds: ["project-zcode", "project-docs"],
  expandedWorkspaceIds: ["ws-main", "ws-feature", "ws-docs-main", "ws-docs-branch"],
  hiddenWorkspaceIds: [],
  pinnedProjectIds: [],
  projectOrder: [],
  workspaceOrder: [],
  activeSessionId: "s-research",
  drafts: { "ws-feature": "保留的草稿" },
  scrollTop: 24,
  workspaceDialogProjectId: null,
  workspaceDraft: EMPTY_WORKSPACE_DRAFT,
  discoveredProjectId: null,
  agentWorkspaceId: null,
  agentDraft: EMPTY_AGENT_DRAFT,
};

export const orcaDiscoveredCandidates = [
  {
    id: "discovered-linked",
    path: "/repos/zcode-old",
    isMainWorktree: false,
    headLabel: "feature/old",
  },
  {
    id: "discovered-detached",
    path: "/repos/zcode-detached",
    isMainWorktree: false,
    headLabel: "detached",
  },
] as const;
