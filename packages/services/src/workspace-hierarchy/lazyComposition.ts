import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import type { ProviderRegistryService } from "@zcode/provider";
import type { ExecutionTarget, SessionSpecV2, HarnessManifest } from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../agent-host/harnessRegistry.js";
import type { IAgentHostService } from "../agent-host/serviceContract.js";
import { createLazyTargetAgentHostService } from "../agent-host/lazyTargetService.js";
import { ProjectCatalog } from "../project-workspaces/projectCatalog.js";
import {
  IProjectCatalogRpcService,
  type ProjectCatalogRpcService,
} from "../project-workspaces/serviceContract.js";
import { type CatalogSessionIndex } from "../project-workspaces/sidebarIndexService.js";
import {
  CatalogWorkspaceAdmission,
  ProjectCatalogTargetBridge,
  type TrustedWorkspaceIdentity,
} from "../project-workspaces/targetBridge.js";
import {
  TargetWorktreeService,
  type TargetRuntimeActivity,
} from "../project-workspaces/worktreeService.js";
import { createExternalSessionIndex } from "./externalSessionIndex.js";
import { createWorkspaceHierarchyService, type NativeHierarchyPort } from "./hierarchyService.js";
import { IWorkspaceHierarchyService } from "./serviceContract.js";
import {
  createMaintenanceCoordination,
  type MaintenanceCoordination,
  type NativeAdmissionFence,
} from "./maintenance.js";

export interface CompositionOptions {
  root: string;
  target: ExecutionTarget;
  registry: ProviderRegistryService;
  identity: TrustedWorkspaceIdentity;
  nativeIndex: CatalogSessionIndex;
  native: NativeHierarchyPort;
  /** Runtime owner supplies native accepted/waiting/uncertain from the real V4 owner, never a constant zero. */
  nativeActivity: (workspaceId?: string) => Promise<TargetRuntimeActivity>;
  newAdmissionsEnabled: () => boolean;
  nativeAdmissionFence: () => Promise<NativeAdmissionFence>;
  initiallyHeld?: boolean;
  additionalTrustedHarnesses?: readonly {
    manifest: HarnessManifest;
    factory: () => HarnessAdapter;
  }[];
  /** Core binds the real Catalog receipt/archive reconciliation, not a window-local fallback. */
  reconcileBoot: (catalog: ProjectCatalog) => Promise<void>;
  resolveRemoteSession?: (workspaceIdentity: string) => Promise<string | undefined>;
}

/** Synchronous service registration, one asynchronous profile/target writer per Host collection. */
export function createLazyWorkspaceComposition(options: CompositionOptions): {
  agentHost: IAgentHostService;
  catalog: ProjectCatalogRpcService;
  hierarchy: IWorkspaceHierarchyService;
  maintenance: MaintenanceCoordination;
  /** Reports the original boot error; never retries an uncertain Git operation. */
  ready(): Promise<void>;
  dispose(): Promise<void>;
} {
  let flight: Promise<{ catalog: ProjectCatalog; target: TargetWorktreeService }> | undefined;
  let disposed = false;
  let bootReady = false;
  let bootFailure: unknown;
  let boot: Promise<void> | undefined;
  const requireBoot = () => {
    if (disposed) throw new Error("Workspace composition disposed");
    if (bootFailure) throw bootFailure;
    if (!bootReady) throw new Error("Catalog reconciliation pending; new admission unavailable");
  };
  const changes = new Emitter<number>();
  let unsubscribe: (() => void) | undefined;
  let host: IAgentHostService;
  const maintenance = createMaintenanceCoordination({
    nativeFence: options.nativeAdmissionFence,
    initiallyHeld: options.initiallyHeld,
    activity: async () => {
      const [native, external] = await Promise.all([
        options.nativeActivity(),
        host.getRuntimeActivity(),
      ]);
      return {
        running: native.running + external.running,
        waiting: native.waiting + external.waiting,
        tools: native.tools,
        uncertain: native.uncertain + external.uncertain,
        offline: native.offline || !options.target.available,
      };
    },
  });
  const newAdmissionsEnabled = () =>
    bootReady && !disposed && maintenance.admissionEnabled() && options.newAdmissionsEnabled();
  const get = () => {
    if (disposed) return Promise.reject(new Error("Workspace composition disposed"));
    if (!flight)
      flight = (async () => {
        const target = await TargetWorktreeService.open({
          storageDirectory: join(options.root, "target"),
          executionTargetId: options.target.id,
          activity: async (workspaceId) => {
            const [native, external] = await Promise.all([
              options.nativeActivity(workspaceId),
              host.getRuntimeActivity(workspaceId),
            ]);
            return {
              running: native.running + external.running,
              waiting: native.waiting + external.waiting,
              tools: native.tools,
              uncertain: native.uncertain + external.uncertain,
              offline: native.offline || !options.target.available,
            };
          },
        });
        try {
          const externalIndex = createExternalSessionIndex(target, host);
          const index: CatalogSessionIndex = {
            onChange(listener) {
              const a = options.nativeIndex.onChange?.(listener);
              const b = externalIndex.onChange?.(listener);
              return () => {
                a?.();
                b?.();
              };
            },
            async allSessions() {
              return [
                ...(await options.nativeIndex.allSessions()),
                ...(await externalIndex.allSessions()),
              ];
            },
            async workspaceFreshness(workspace) {
              const [native, external] = await Promise.all([
                options.nativeIndex.workspaceFreshness(workspace),
                externalIndex.workspaceFreshness(workspace),
              ]);
              if (native === "offline" || external === "offline") return "offline";
              if (native === "stale" || external === "stale") return "stale";
              if (native === "live" || external === "live") return "live";
              return "unknown";
            },
          };
          const catalog = await ProjectCatalog.open(
            join(options.root, "profile", "catalog.json"),
            new ProjectCatalogTargetBridge(target, options.target.id, options.identity),
            index,
          );
          unsubscribe = catalog.onChange((revision) => changes.fire(revision));
          // 中文：读服务先开放；新 admission 必须等持久 Target receipt 与归档策略核对完毕。
          // 保留首次失败供查询，不能重新打开 Catalog 或重试 Git 来伪装成功。
          boot = Promise.resolve()
            .then(() => options.reconcileBoot(catalog))
            .then(
              () => {
                if (!disposed) bootReady = true;
              },
              (error: unknown) => {
                bootFailure = error;
              },
            );
          return { catalog, target };
        } catch (error) {
          await target.close();
          throw error;
        }
      })().catch((error: unknown) => {
        flight = undefined;
        throw error;
      });
    return flight;
  };
  const admission = {
    async verify(spec: SessionSpecV2) {
      const { catalog, target } = await get();
      return new CatalogWorkspaceAdmission(catalog, target, options.target.id).verify(spec);
    },
    async withAdmission<T>(
      spec: SessionSpecV2,
      action: (verified: { canonicalCwd: string }) => Promise<T>,
    ): Promise<T> {
      const { catalog, target } = await get();
      requireBoot();
      return maintenance.withAdmission(() => {
        // 中文：等待 maintenance lease 时可能发生 dispose/reconcile 失败，取锁后再确认 owner。
        requireBoot();
        return new CatalogWorkspaceAdmission(catalog, target, options.target.id).withAdmission(
          spec,
          (canonicalCwd) => action({ canonicalCwd }),
        );
      });
    },
  };
  const agent = createLazyTargetAgentHostService({
    root: join(options.root, "agent-host"),
    target: options.target,
    registry: options.registry,
    admission,
    allowNewSessions: newAdmissionsEnabled,
    additionalTrustedHarnesses: options.additionalTrustedHarnesses,
  });
  host = agent.service;
  const catalog: ProjectCatalogRpcService = {
    onDidChange: changes.event,
    getRevision: async () => (await get()).catalog.getRevision(),
    sidebarSnapshot: async () => (await get()).catalog.sidebarSnapshot(),
    project: async (id) => (await get()).catalog.project(id),
    binding: async (id) => (await get()).catalog.binding(id),
    workspace: async (id) => (await get()).catalog.workspace(id),
    importProject: async (request) => {
      const { catalog } = await get();
      requireBoot();
      return maintenance.withAdmission(() => catalog.importProject(request));
    },
    updateProject: async (id, update) => {
      const { catalog } = await get();
      requireBoot();
      return maintenance.withAdmission(() => catalog.updateProject(id, update));
    },
    updateWorkspace: async (id, update) => {
      const { catalog } = await get();
      requireBoot();
      return maintenance.withAdmission(() => catalog.updateWorkspace(id, update));
    },
    discover: async (id) => {
      const { catalog } = await get();
      requireBoot();
      return maintenance.withAdmission(() => catalog.discover(id));
    },
    adopt: async (request) => {
      const { catalog } = await get();
      requireBoot();
      return maintenance.withAdmission(() => catalog.adopt(request));
    },
    create: async (request) => {
      const { catalog } = await get();
      requireBoot();
      return maintenance.withAdmission(() => catalog.create(request));
    },
    remove: async (request) => {
      const { catalog } = await get();
      requireBoot();
      return maintenance.withAdmission(() => catalog.remove(request));
    },
    previewRemoval: async (id, generation) => (await get()).catalog.previewRemoval(id, generation),
    apply: async (operation) => {
      const { catalog } = await get();
      requireBoot();
      return maintenance.withAdmission(() => catalog.apply(operation));
    },
    // 中文：启动核对只能由 Core owner 单次执行；RPC 不允许重跑失败的未知 Git 意图。
    reconcilePending: async () => {
      throw new Error("Core owns boot reconciliation; retry unavailable");
    },
    reconcileArchivePolicies: async () => {
      throw new Error("Core owns boot reconciliation; retry unavailable");
    },
  };
  const hierarchy = createWorkspaceHierarchyService({
    targetId: options.target.id,
    catalog,
    host,
    registry: options.registry,
    recoveryFacts: async (workspaceId) => {
      const { target } = await get();
      try {
        const result = await target.lookupWorkspace(workspaceId);
        if (result) {
          if (result.receipt.kind === "import")
            throw new Error("Unexpected workspace import receipt");
          return {
            status: "confirmed" as const,
            generation: result.record.generation,
            receiptKind: result.receipt.kind,
          };
        }
      } catch (error) {
        // 中文：仅持久待创建意图能证明结果未知；其它目标实例/仓库校验失败不能
        // 被吞成「收据不可用」，必须把原始失败传给调用者。
        if (!target.pendingCreations().some((row) => row.workspaceId === workspaceId)) throw error;
        return { status: "unresolved" as const, reason: "target-result-unknown" as const };
      }
      return { status: "unresolved" as const, reason: "target-receipts-unavailable" as const };
    },
    native: options.native,
    commitNativeReference: async (reference) =>
      (await get()).catalog.commitNativeReference(reference),
    newAdmissionsEnabled,
    withNativeAdmission: (workspaceId, generation, cwd, action) =>
      maintenance.withAdmission(async () => {
        requireBoot();
        const { target } = await get();
        // 中文：不能在同一 Target exclusive 内重进 public lookupWorkspace；仅持有者
        // 可取得仍验证租约和 Git 实例的 scoped facts，直至映射与 Catalog fsync 完毕。
        return target.withAdmission(
          workspaceId,
          generation,
          (_canonical, lease) =>
            action({
              recoveryFacts: async (id) => {
                if (id !== workspaceId) throw new Error("Target admission workspace mismatch");
                const result = await lease.lookupWorkspace();
                if (!result)
                  return {
                    status: "unresolved" as const,
                    reason: "target-receipts-unavailable" as const,
                  };
                if (result.receipt.kind === "import")
                  throw new Error("Unexpected workspace import receipt");
                return {
                  status: "confirmed" as const,
                  generation: result.record.generation,
                  receiptKind: result.receipt.kind,
                };
              },
            }),
          cwd,
        );
      }),
    resolveRemoteSession: options.resolveRemoteSession,
  });
  return {
    agentHost: host,
    catalog,
    hierarchy,
    maintenance,
    async ready() {
      await get();
      await boot;
      requireBoot();
    },
    async dispose() {
      disposed = true;
      bootReady = false;
      unsubscribe?.();
      changes.dispose();
      await agent.dispose();
      const ready = await flight?.catch(() => undefined);
      await boot;
      await ready?.catalog.close();
      await ready?.target.close();
    },
  };
}
export { IProjectCatalogRpcService, IWorkspaceHierarchyService };
