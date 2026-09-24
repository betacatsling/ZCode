import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IServiceAccessor, IProjectCatalogService } from "@zcode/services";
import type {
  HarnessCatalogEntry,
  ModelBindingRequest,
  SessionSpecV2,
} from "@zcode/shared/agent-host";
import {
  parseSidebarSnapshot,
  type SessionSummary,
  type SidebarSnapshot,
} from "@zcode/shared/project-workspaces";
import type { SidebarIconAsset } from "../agent-host/harnessAssetResolver.js";
import type { ProjectSidebarProps, SidebarActions } from "../project-sidebar/types.js";
import { readMountedCreateChoices } from "./mountedProjectCreateChoices.js";
import { resolveMountedSidebarOwner } from "./mountedProjectSidebarNavigation.js";

/** UI's read/command slice of the Host contract. The production accessor supplies this after integration. */
export type MountedSessionOwner =
  | { kind: "native"; scope: MountedNavigationScope; originalSessionId: string }
  | { kind: "external"; scope: MountedNavigationScope; spec: SessionSpecV2; historyOnly: boolean };
export interface MountedNavigationScope {
  targetId: string;
  workspaceId: string;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId?: string;
}
export interface MountedHierarchyService {
  resolveOwner(input: {
    targetId: string;
    workspaceId: string;
    sessionId: string;
  }): Promise<MountedSessionOwner | undefined>;
  listHarnesses(workspaceId: string): Promise<readonly HarnessCatalogEntry[]>;
  /** Target-scoped Model catalog + certified Harness capabilities; no UI-guessed fallback. */
  listCreateOptions?(workspaceId: string): Promise<{
    workspaceId: string;
    worktreeGeneration: string;
    options: readonly { harnessId: string; label: string; binding: ModelBindingRequest }[];
  }>;
  /** Trusted target preflight; the target still rechecks before remove. */
  previewRemoval?(
    workspaceId: string,
    expectedGeneration: string,
  ): Promise<{
    allowed: boolean;
    risks: readonly string[];
  }>;
  createAgent(input: {
    workspaceId: string;
    harnessId: string;
    modelBinding: ModelBindingRequest;
    cwdRelativeToWorktree?: string;
    commandId: string;
  }): Promise<{ owner: MountedSessionOwner }>;
  asset(assetId: string): Promise<SidebarIconAsset | undefined>;
}
export type MountedHierarchyServices = {
  projectCatalogService: Pick<
    IProjectCatalogService,
    | "sidebarSnapshot"
    | "importProject"
    | "discover"
    | "adopt"
    | "create"
    | "updateWorkspace"
    | "remove"
  >;
  workspaceHierarchyService: MountedHierarchyService;
};

/** No structural guess from an AgentHost alone; the two authoritative services must both exist. */
export function hasMountedHierarchy(
  services: IServiceAccessor,
): services is IServiceAccessor & MountedHierarchyServices {
  return (
    "projectCatalogService" in services &&
    typeof services.projectCatalogService === "object" &&
    services.projectCatalogService !== null &&
    "sidebarSnapshot" in services.projectCatalogService &&
    typeof services.projectCatalogService.sidebarSnapshot === "function" &&
    "importProject" in services.projectCatalogService &&
    typeof services.projectCatalogService.importProject === "function" &&
    "workspaceHierarchyService" in services &&
    typeof services.workspaceHierarchyService === "object" &&
    services.workspaceHierarchyService !== null &&
    "resolveOwner" in services.workspaceHierarchyService &&
    typeof services.workspaceHierarchyService.resolveOwner === "function" &&
    "listHarnesses" in services.workspaceHierarchyService &&
    typeof services.workspaceHierarchyService.listHarnesses === "function" &&
    "createAgent" in services.workspaceHierarchyService &&
    typeof services.workspaceHierarchyService.createAgent === "function" &&
    "asset" in services.workspaceHierarchyService &&
    typeof services.workspaceHierarchyService.asset === "function"
  );
}

export function useMountedProjectSidebar({
  services,
  onNavigate,
  locale,
}: {
  services: MountedHierarchyServices;
  onNavigate: (owner: MountedSessionOwner) => void;
  locale: "en" | "zh";
}): Omit<
  Pick<
    ProjectSidebarProps,
    | "snapshot"
    | "catalog"
    | "actions"
    | "targetLabels"
    | "resolveIconAsset"
    | "discovery"
    | "locale"
    | "modelOptions"
    | "modelOptionsByWorkspace"
    | "catalogByWorkspace"
  >,
  "snapshot"
> & { snapshot?: SidebarSnapshot; error?: string } {
  const catalogService = services.projectCatalogService;
  const hierarchy = services.workspaceHierarchyService;
  const [snapshot, setSnapshot] = useState<SidebarSnapshot>();
  const [catalog, setCatalog] = useState<readonly HarnessCatalogEntry[]>([]);
  const [catalogByWorkspace, setCatalogByWorkspace] = useState<
    ReadonlyMap<string, readonly HarnessCatalogEntry[]>
  >(new Map());
  const [workspaceOptions, setWorkspaceOptions] = useState<
    ReadonlyMap<
      string,
      readonly { harnessId: string; label: string; binding: ModelBindingRequest }[]
    >
  >(new Map());
  const [discovery, setDiscovery] = useState<NonNullable<ProjectSidebarProps["discovery"]>>({});
  const [assets, setAssets] = useState<Record<string, SidebarIconAsset>>({});
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const creationCommands = useRef(
    new Map<string, { commandId: string; owner?: MountedSessionOwner }>(),
  );
  const importIds = useRef(new Map<string, { id: string; bindingId: string }>());
  const refreshSequence = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++refreshSequence.current;
    const raw = await catalogService.sidebarSnapshot();
    const next = parseSidebarSnapshot(raw);
    if (request !== refreshSequence.current) return;
    const activeWorkspaces = next.workspaces.filter((w) => w.lifecycle === "active");
    const harnessLists = await Promise.all(
      activeWorkspaces.map((w) => hierarchy.listHarnesses(w.id)),
    );
    const entries = [
      ...new Map(harnessLists.flat().map((entry) => [entry.manifest.id, entry])).values(),
    ];
    if (request !== refreshSequence.current) return;
    // 修复旧 picker 为每个 supported Harness 伪造 harness-managed 选项：只接受目标
    // 针对此 workspace/generation 验证过的 Model catalog + capability 结果，缺接口时不可创建。
    const choices = await readMountedCreateChoices(activeWorkspaces, harnessLists, hierarchy);
    if (request !== refreshSequence.current) return;
    // 修复刷新中展示旧 generation 选项：将 snapshot/catalog/options 同批发布。
    setSnapshot(next);
    setCatalog(entries);
    setCatalogByWorkspace(
      new Map(activeWorkspaces.map((workspace, index) => [workspace.id, harnessLists[index]!])),
    );
    setWorkspaceOptions(choices);
    setError(undefined);
    setStale(false);
    const ids = [
      ...new Set(
        entries
          .flatMap((entry) => [entry.manifest.icon?.light, entry.manifest.icon?.dark])
          .filter((id): id is string => Boolean(id)),
      ),
    ];
    const resolved = await Promise.all(
      ids.map(async (id) => [id, await hierarchy.asset(id)] as const),
    );
    const available: Record<string, SidebarIconAsset> = {};
    for (const [id, asset] of resolved) if (asset !== undefined) available[id] = asset;
    if (request === refreshSequence.current) setAssets(available);
  }, [catalogService, hierarchy]);
  useEffect(() => {
    let active = true;
    void refresh().catch((cause) => {
      if (active) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setStale(true);
      }
    });
    const onFocus = () => {
      void refresh().catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : String(cause));
          setStale(true);
        }
      });
    };
    window.addEventListener("focus", onFocus);
    return () => {
      active = false;
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh]);
  const navigate = useCallback(
    async (summary: SessionSummary) => {
      onNavigate(await resolveMountedSidebarOwner(summary, snapshot, hierarchy));
    },
    [hierarchy, onNavigate, snapshot],
  );
  const execute = useCallback(
    async (action: () => Promise<unknown>) => {
      await action();
      await refresh();
    },
    [refresh],
  );
  const actions = useMemo<SidebarActions>(
    () => ({
      onImportProject: async ({ name, targetId, repositoryPath }) => {
        const key = JSON.stringify([targetId, repositoryPath, name]);
        const ids = importIds.current.get(key) ?? {
          id: crypto.randomUUID(),
          bindingId: crypto.randomUUID(),
        };
        importIds.current.set(key, ids);
        await execute(() =>
          catalogService.importProject({ ...ids, name, targetId, repositoryPath }),
        );
        importIds.current.delete(key);
      },
      onSelectSession: async (summary) => {
        try {
          await navigate(summary);
        } catch (cause) {
          setError(String(cause));
          throw cause;
        }
      },
      onOpenAttention: (summary) => {
        void navigate(summary).catch((cause) => setError(String(cause)));
      },
      onCreateAgent: async (input) => {
        const key = JSON.stringify(input);
        const intent = creationCommands.current.get(key) ?? { commandId: crypto.randomUUID() };
        creationCommands.current.set(key, intent);
        // 修复重试误重复分配：同一 intent/dialog 的命令 ID 保留到 Host 确认后才撤销。
        const workspace = snapshot?.workspaces.find((item) => item.id === input.workspaceId);
        const binding = snapshot?.bindings.find(
          (item) => item.id === workspace?.repositoryBindingId,
        );
        if (
          stale ||
          !workspace ||
          !binding ||
          workspace.worktreeGeneration !== input.expectedGeneration
        )
          throw new Error("Stale workspace generation");
        const allowed = workspaceOptions
          .get(input.workspaceId)
          ?.some(
            (option) =>
              option.harnessId === input.harnessId &&
              JSON.stringify(option.binding) === JSON.stringify(input.modelBinding),
          );
        if (!allowed) throw new Error("Model binding unavailable for workspace");
        const owner =
          intent.owner ??
          (
            await hierarchy.createAgent({
              workspaceId: input.workspaceId,
              harnessId: input.harnessId,
              modelBinding: input.modelBinding,
              commandId: intent.commandId,
            })
          ).owner;
        if (
          owner.scope.workspaceId !== input.workspaceId ||
          owner.scope.targetId !== binding.executionTargetId ||
          (owner.kind === "external" &&
            (owner.spec.execution.worktreeGeneration !== input.expectedGeneration ||
              owner.spec.modelBinding.kind !== input.modelBinding.kind))
        )
          throw new Error("Mismatched creation owner");
        // Host 已接受后记录 receipt；刷新/导航异常不得用新命令重建会话。
        intent.owner = owner;
        await refresh();
        onNavigate(owner);
        creationCommands.current.delete(key);
      },
      onDiscover: async (bindingId) => {
        const found = await catalogService.discover(bindingId);
        setDiscovery((previous) => ({
          ...previous,
          [bindingId]: found.map((item) => ({
            path: item.worktreePath,
            label: item.worktreePath,
            head: item.head.kind === "branch" ? item.head.ref : item.head.oid,
          })),
        }));
      },
      onAdopt: (bindingId, path) =>
        execute(() =>
          catalogService.adopt({
            bindingId,
            workspaceId: crypto.randomUUID(),
            title: path.split(/[\\/]/).pop() || path,
            worktreePath: path,
          }),
        ),
      onCreateWorkspace: (input) =>
        execute(() =>
          catalogService.create({
            bindingId: input.repositoryBindingId,
            workspaceId: crypto.randomUUID(),
            title: input.title,
            worktreePath: input.worktreePath,
            baseRef: input.baseRef,
            branch: input.branch,
          }),
        ),
      onHideWorkspace: (id) => execute(() => catalogService.updateWorkspace(id, { hidden: true })),
      onShowWorkspace: (id) => execute(() => catalogService.updateWorkspace(id, { hidden: false })),
      onArchiveWorkspace: (id) =>
        execute(() => catalogService.updateWorkspace(id, { archived: true })),
      onUnarchiveWorkspace: (id) =>
        execute(() => catalogService.updateWorkspace(id, { archived: false })),
      onPreviewRemove: async (id, expectedGeneration) => {
        const workspace = snapshot?.workspaces.find((w) => w.id === id);
        if (
          stale ||
          !workspace ||
          workspace.isMainWorktree ||
          workspace.lifecycle !== "active" ||
          workspace.worktreeGeneration !== expectedGeneration ||
          !hierarchy.previewRemoval
        )
          throw new Error("Target removal preview unavailable");
        return hierarchy.previewRemoval(id, expectedGeneration);
      },
      onRemoveWorkspace: async (id, expectedGeneration) => {
        const workspace = snapshot?.workspaces.find((w) => w.id === id);
        if (
          stale ||
          !workspace ||
          workspace.isMainWorktree ||
          workspace.lifecycle !== "active" ||
          workspace.worktreeGeneration !== expectedGeneration ||
          !hierarchy.previewRemoval
        )
          throw new Error("Target removal preview unavailable");
        const preview = await hierarchy.previewRemoval(id, expectedGeneration);
        if (!preview.allowed)
          throw new Error(preview.risks.join("; ") || "Target rejected removal");
        await execute(() =>
          catalogService.remove({ workspaceId: id, expectedGeneration, confirmation: true }),
        );
      },
    }),
    [
      catalogService,
      execute,
      hierarchy,
      navigate,
      onNavigate,
      refresh,
      snapshot,
      stale,
      workspaceOptions,
    ],
  );
  const targetLabels = useMemo(
    () =>
      Object.fromEntries(
        snapshot?.bindings.map((b) => [b.executionTargetId, b.executionTargetId]) ?? [],
      ),
    [snapshot],
  );
  const resolveIconAsset = useCallback((id: string) => assets[id], [assets]);
  const displaySnapshot = useMemo(
    () =>
      !stale || !snapshot
        ? snapshot
        : {
            ...snapshot,
            sessions: snapshot.sessions.map((session) => ({
              ...session,
              freshness: "offline" as const,
            })),
            workspaceSummaries: snapshot.workspaceSummaries.map((summary) => ({
              ...summary,
              freshness: "offline" as const,
            })),
          },
    [snapshot, stale],
  );
  return {
    snapshot: displaySnapshot,
    catalog,
    catalogByWorkspace,
    actions,
    targetLabels,
    discovery,
    locale,
    modelOptionsByWorkspace: workspaceOptions,
    resolveIconAsset,
    error,
  };
}
