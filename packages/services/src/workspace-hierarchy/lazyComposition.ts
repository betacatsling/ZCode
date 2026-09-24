import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import type { ProviderRegistryService } from "@zcode/provider";
import type { ExecutionTarget, SessionSpecV2 } from "@zcode/shared/agent-host";
import type { IAgentHostService } from "../agent-host/serviceContract.js";
import { createLazyTargetAgentHostService } from "../agent-host/lazyTargetService.js";
import { ProjectCatalog } from "../project-workspaces/projectCatalog.js";
import { IProjectCatalogRpcService, type ProjectCatalogRpcService } from "../project-workspaces/serviceContract.js";
import { type CatalogSessionIndex } from "../project-workspaces/sidebarIndexService.js";
import { CatalogWorkspaceAdmission, ProjectCatalogTargetBridge, type TrustedWorkspaceIdentity } from "../project-workspaces/targetBridge.js";
import { TargetWorktreeService, type TargetRuntimeActivity } from "../project-workspaces/worktreeService.js";
import { createExternalSessionIndex } from "./externalSessionIndex.js";
import { createWorkspaceHierarchyService, type NativeHierarchyPort } from "./hierarchyService.js";
import { IWorkspaceHierarchyService } from "./serviceContract.js";
import { createMaintenanceCoordination, type MaintenanceCoordination } from "./maintenance.js";

export interface CompositionOptions {
  root: string;
  target: ExecutionTarget;
  registry: ProviderRegistryService;
  identity: TrustedWorkspaceIdentity;
  nativeIndex?: CatalogSessionIndex;
  native?: NativeHierarchyPort;
  /** Runtime owner supplies native accepted/waiting/uncertain from the real V4 owner, never a constant zero. */
  nativeActivity?: (workspaceId?: string) => Promise<TargetRuntimeActivity>;
  newAdmissionsEnabled: () => boolean;
  nativeAdmissionFence?: () => Promise<() => Promise<void>>;
  resolveRemoteSession?: (workspaceIdentity: string) => Promise<string | undefined>;
}

/** Synchronous service registration, one asynchronous profile/target writer per Host collection. */
export function createLazyWorkspaceComposition(options: CompositionOptions): {
  agentHost: IAgentHostService;
  catalog: ProjectCatalogRpcService;
  hierarchy: IWorkspaceHierarchyService;
  maintenance: MaintenanceCoordination;
  dispose(): Promise<void>;
} {
  let flight: Promise<{ catalog: ProjectCatalog; target: TargetWorktreeService }> | undefined;
  let disposed = false;
  const changes = new Emitter<number>();
  let unsubscribe: (() => void) | undefined;
  let host: IAgentHostService;
  const maintenance = createMaintenanceCoordination({
    nativeFence: () => {
      if (!options.nativeAdmissionFence) throw new Error("Native admission fence unavailable");
      return options.nativeAdmissionFence();
    },
    activity: async () => {
      if (!options.nativeActivity || !options.nativeIndex) return { running: 0, waiting: 0, tools: 0, uncertain: 1, offline: true };
      const [native, external] = await Promise.all([options.nativeActivity(), host.getRuntimeActivity()]);
      return { running: native.running + external.running, waiting: native.waiting + external.waiting,
        tools: native.tools, uncertain: native.uncertain + external.uncertain,
        offline: native.offline || !options.target.available };
    },
  });
  const newAdmissionsEnabled = () => maintenance.admissionEnabled() && options.newAdmissionsEnabled();
  const get = () => {
    if (disposed) return Promise.reject(new Error("Workspace composition disposed"));
    if (!flight) flight = (async () => {
      const target = await TargetWorktreeService.open({
        storageDirectory: join(options.root, "target"), executionTargetId: options.target.id,
        activity: async (workspaceId) => {
          if (!options.nativeActivity || !options.nativeIndex) return { running: 0, waiting: 0, tools: 0, uncertain: 1, offline: true };
          const [native, external] = await Promise.all([options.nativeActivity(workspaceId), host.getRuntimeActivity(workspaceId)]);
          return { running: native.running + external.running, waiting: native.waiting + external.waiting,
            tools: native.tools, uncertain: native.uncertain + external.uncertain, offline: native.offline || !options.target.available };
        },
      });
      try {
        const externalIndex = createExternalSessionIndex(target, host);
        // 中文：缺少原生完整索引时不能以空列表伪装全量事实；读目录和新 admission 显式失败。
        const index: CatalogSessionIndex = {
          onChange(listener) {
            const a = options.nativeIndex?.onChange?.(listener);
            const b = externalIndex.onChange?.(listener);
            return () => { a?.(); b?.(); };
          },
          async allSessions() {
            if (!options.nativeIndex) throw new Error("Native complete index unavailable");
            return [...await options.nativeIndex.allSessions(), ...await externalIndex.allSessions()];
          },
          async workspaceFreshness(workspace) {
            if (!options.nativeIndex) return "unknown";
            const [native, external] = await Promise.all([
              options.nativeIndex.workspaceFreshness(workspace), externalIndex.workspaceFreshness(workspace),
            ]);
            if (native === "offline" || external === "offline") return "offline";
            if (native === "stale" || external === "stale") return "stale";
            if (native === "live" || external === "live") return "live";
            return "unknown";
          },
        };
        const catalog = await ProjectCatalog.open(join(options.root, "profile", "catalog.json"),
          new ProjectCatalogTargetBridge(target, options.target.id, options.identity), index);
        unsubscribe = catalog.onChange((revision) => changes.fire(revision));
        return { catalog, target };
      } catch (error) { await target.close(); throw error; }
    })().catch((error: unknown) => { flight = undefined; throw error; });
    return flight;
  };
  const admission = {
    async verify(spec: SessionSpecV2) {
      const { catalog, target } = await get();
      return new CatalogWorkspaceAdmission(catalog, target, options.target.id).verify(spec);
    },
    async withAdmission<T>(spec: SessionSpecV2, action: (verified: { canonicalCwd: string }) => Promise<T>): Promise<T> {
      const { catalog, target } = await get();
      return maintenance.withAdmission(() => new CatalogWorkspaceAdmission(catalog, target, options.target.id)
        .withAdmission(spec, (canonicalCwd) => action({ canonicalCwd })));
    },
  };
  const agent = createLazyTargetAgentHostService({ root: join(options.root, "agent-host"),
    target: options.target, registry: options.registry, admission, allowNewSessions: newAdmissionsEnabled });
  host = agent.service;
  const catalog: ProjectCatalogRpcService = {
    onDidChange: changes.event,
    getRevision: async () => (await get()).catalog.getRevision(),
    sidebarSnapshot: async () => (await get()).catalog.sidebarSnapshot(),
    project: async (id) => (await get()).catalog.project(id),
    binding: async (id) => (await get()).catalog.binding(id),
    workspace: async (id) => (await get()).catalog.workspace(id),
    importProject: async (request) => (await get()).catalog.importProject(request),
    updateProject: async (id, update) => (await get()).catalog.updateProject(id, update),
    updateWorkspace: async (id, update) => (await get()).catalog.updateWorkspace(id, update),
    discover: async (id) => (await get()).catalog.discover(id),
    adopt: async (request) => (await get()).catalog.adopt(request),
    create: async (request) => (await get()).catalog.create(request),
    remove: async (request) => (await get()).catalog.remove(request),
    previewRemoval: async (id, generation) => (await get()).catalog.previewRemoval(id, generation),
    apply: async (operation) => (await get()).catalog.apply(operation),
  };
  const hierarchy = createWorkspaceHierarchyService({ targetId: options.target.id, catalog,
    host, native: options.native, newAdmissionsEnabled, resolveRemoteSession: options.resolveRemoteSession });
  return { agentHost: host, catalog, hierarchy, maintenance,
    async dispose() {
      disposed = true;
      unsubscribe?.();
      changes.dispose();
      await agent.dispose();
      const ready = await flight?.catch(() => undefined);
      await ready?.catalog.close();
      await ready?.target.close();
    },
  };
}
export { IProjectCatalogRpcService, IWorkspaceHierarchyService };
