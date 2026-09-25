/* oxlint-disable eslint(max-lines) -- Mounted sidebar owns one Catalog refresh/navigation/intent controller; splitting its ordered async closure would duplicate local request versions. */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type {
  IServiceAccessor,
  IProjectCatalogService,
  IWorkspaceHierarchyService,
  SessionOwner,
} from "@zcode/services";
import type { HarnessCatalogEntry, ModelBindingRequest } from "@zcode/shared/agent-host";
import {
  parseSidebarSnapshot,
  type SessionSummary,
  type SidebarSnapshot,
} from "@zcode/shared/project-workspaces";
import type { SidebarIconAsset } from "../agent-host/harnessAssetResolver.js";
import type { ProjectSidebarProps, SidebarActions } from "../project-sidebar/types.js";
import { readMountedCreateChoices } from "./mountedProjectCreateChoices.js";
import { resolveMountedSidebarOwner } from "./mountedProjectSidebarNavigation.js";

/** The public hierarchy contract is the only owner type; never narrow away native historyOnly. */
export type MountedSessionOwner = SessionOwner;
export type MountedHierarchyService = Pick<
  IWorkspaceHierarchyService,
  | "resolveOwner"
  | "listHarnesses"
  | "listCreateOptions"
  | "createAgent"
  | "asset"
  | "previewRemoval"
>;
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
    // 原因：真实 RemoteServiceAccess 使用 RPC Proxy#get，`method in proxy` 恒为 false；
    // 这里只检验可调用接口，实际鉴权及能力由目标 RPC 拒绝/返回结果裁决。
    typeof services.projectCatalogService.sidebarSnapshot === "function" &&
    typeof services.projectCatalogService.importProject === "function" &&
    "workspaceHierarchyService" in services &&
    typeof services.workspaceHierarchyService === "object" &&
    services.workspaceHierarchyService !== null &&
    typeof services.workspaceHierarchyService.resolveOwner === "function" &&
    typeof services.workspaceHierarchyService.listHarnesses === "function" &&
    typeof services.workspaceHierarchyService.listCreateOptions === "function" &&
    typeof services.workspaceHierarchyService.createAgent === "function" &&
    typeof services.workspaceHierarchyService.asset === "function"
  );
}

export function useMountedProjectSidebar({
  services,
  onNavigate,
  locale,
  navigationScope,
}: {
  services: MountedHierarchyServices;
  onNavigate: (owner: MountedSessionOwner) => void;
  locale: "en" | "zh";
  navigationScope?: string;
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
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
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
  const refreshReady = useRef(false);
  const navigationSequence = useRef(0);
  useLayoutEffect(
    () => () => {
      // Bug 原因：workspace/endpoint 切换时即便 Catalog 未刷新，旧查询仍可能晚完成。
      navigationSequence.current += 1;
    },
    [hierarchy, navigationScope],
  );
  useEffect(
    () => () => {
      refreshSequence.current += 1;
    },
    [hierarchy, catalogService],
  );
  const refresh = useCallback(async () => {
    const request = ++refreshSequence.current;
    refreshReady.current = false;
    // Bug 原因：刷新中旧 generation 的选项在 I/O 等待期间仍可被点击。
    setWorkspaceOptions(new Map());
    try {
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
      refreshReady.current = true;
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
        ids.map(async (id) => [id, await hierarchy.asset(id).catch(() => undefined)] as const),
      );
      const available: Record<string, SidebarIconAsset> = {};
      for (const [id, asset] of resolved) if (asset !== undefined) available[id] = asset;
      if (request === refreshSequence.current) setAssets(available);
    } catch (cause) {
      // Bug 原因：旧刷新拒绝在新成功之后到达，不得覆盖新 Catalog 的在线状态。
      if (request !== refreshSequence.current) return;
      refreshReady.current = false;
      setError(cause instanceof Error ? cause.message : String(cause));
      setStale(true);
    }
  }, [catalogService, hierarchy]);
  useEffect(() => {
    void refresh();
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      // Bug 原因：scope 卸载后迟到的刷新拒绝不能更新已卸载树或新 scope。
      refreshSequence.current += 1;
      refreshReady.current = false;
    };
  }, [refresh]);
  const navigate = useCallback(
    async (summary: SessionSummary) => {
      // Bug 原因：较早的 owner lookup 晚完成会覆盖最后点击；旧请求的拒绝也不能报错。
      const request = ++navigationSequence.current;
      // Bug 原因：离线保留的只读行仍可点击；不能用旧 Catalog 发起 owner 查询。
      if (stale || !refreshReady.current) return;
      const catalogRequest = refreshSequence.current;
      const source = snapshot;
      const generation = source?.workspaces.find(
        (w) => w.id === summary.session.workspaceId,
      )?.worktreeGeneration;
      try {
        const owner = await resolveMountedSidebarOwner(summary, source, hierarchy);
        if (
          request !== navigationSequence.current ||
          !refreshReady.current ||
          catalogRequest !== refreshSequence.current ||
          source !== snapshotRef.current ||
          source?.workspaces.find((w) => w.id === owner.scope.workspaceId)?.worktreeGeneration !==
            generation
        )
          return;
        onNavigate(owner);
      } catch (cause) {
        if (
          request !== navigationSequence.current ||
          !refreshReady.current ||
          catalogRequest !== refreshSequence.current ||
          source !== snapshotRef.current
        )
          return;
        throw cause;
      }
    },
    [hierarchy, onNavigate, snapshot, stale],
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
        ++navigationSequence.current;
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
          !refreshReady.current ||
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
      onPreviewRemoval: async (id, expectedGeneration) => {
        const workspace = snapshot?.workspaces.find((w) => w.id === id);
        if (
          stale ||
          !refreshReady.current ||
          !workspace ||
          workspace.isMainWorktree ||
          workspace.lifecycle !== "active" ||
          workspace.worktreeGeneration !== expectedGeneration ||
          !hierarchy.previewRemoval
        )
          throw new Error("Target removal preview unavailable");
        return hierarchy.previewRemoval({ workspaceId: id, expectedGeneration });
      },
      onRemoveWorkspace: async (id, expectedGeneration) => {
        const workspace = snapshot?.workspaces.find((w) => w.id === id);
        if (
          stale ||
          !refreshReady.current ||
          !workspace ||
          workspace.isMainWorktree ||
          workspace.lifecycle !== "active" ||
          workspace.worktreeGeneration !== expectedGeneration ||
          !hierarchy.previewRemoval
        )
          throw new Error("Target removal preview unavailable");
        const preview = await hierarchy.previewRemoval({ workspaceId: id, expectedGeneration });
        if (
          preview.workspaceId !== id ||
          preview.generation !== expectedGeneration ||
          !preview.safe ||
          preview.unknown ||
          !preview.git ||
          !preview.activity ||
          preview.activity.offline ||
          [
            preview.activity.running,
            preview.activity.waiting,
            preview.activity.tools,
            preview.activity.uncertain,
          ].some((count) => !Number.isSafeInteger(count) || count !== 0)
        )
          throw new Error("Target rejected removal or activity is unknown");
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
