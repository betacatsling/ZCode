import { randomUUID } from "node:crypto";
import {
  deriveWritableSessionSpec,
  type HarnessCapabilitiesV2,
  type ModelBindingRequest,
  type SessionSpecV2,
} from "@zcode/shared/agent-host";
import type { IAgentHostService } from "../agent-host/serviceContract.js";
import { nativeHarnessAssetMetadata, resolveHarnessAsset } from "../harness-assets/index.js";
import type { IProjectCatalogService } from "../project-workspaces/serviceContract.js";
import type {
  IWorkspaceHierarchyService,
  SessionOwner,
  WorkspaceNavigationScope,
} from "./serviceContract.js";

/** Native V4 is the only authority for original session IDs, creation and capability truth. */
export interface NativeHierarchyPort {
  resolveOwner(input: { targetId: string; workspaceId: string; sessionId: string }): Promise<
    | {
        originalSessionId: string;
        sourceWorkspacePath: string;
        workspaceIdentity: string;
        remoteSessionId?: string;
        /** Original target instance provenance; absent legacy facts may only open history. */
        worktreeGeneration?: string;
        repositoryBindingId?: string;
      }
    | undefined
  >;
  create(input: {
    scope: WorkspaceNavigationScope;
    commandId: string;
    modelBinding: ModelBindingRequest;
    cwdRelativeToWorktree: string;
  }): Promise<{ originalSessionId: string }>;
  capabilities(owner: Extract<SessionOwner, { kind: "native" }>): Promise<HarnessCapabilitiesV2>;
}

/** Strictly target-local service; never project unknown IDs into native task storage. */
export function createWorkspaceHierarchyService(input: {
  targetId: string;
  catalog: Pick<IProjectCatalogService, "sidebarSnapshot" | "previewRemoval">;
  host: IAgentHostService;
  native?: NativeHierarchyPort;
  newAdmissionsEnabled: () => boolean;
  /** Authenticated window attachment registry, not an identity inferred from path. */
  resolveRemoteSession?: (workspaceIdentity: string) => Promise<string | undefined>;
}): IWorkspaceHierarchyService {
  const scopeFor = async (workspaceId: string): Promise<WorkspaceNavigationScope | undefined> => {
    const snapshot = await input.catalog.sidebarSnapshot();
    const workspace = snapshot.workspaces.find((row) => row.id === workspaceId);
    const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
    if (!workspace || !binding || binding.executionTargetId !== input.targetId) return undefined;
    return {
      workspaceId: workspace.id,
      targetId: binding.executionTargetId,
      workspaceIdentity: workspace.workspaceIdentity,
      workspacePath: workspace.worktreePath,
    };
  };
  const ownerForSpec = async (spec: SessionSpecV2): Promise<SessionOwner> => {
    const snapshot = await input.catalog.sidebarSnapshot();
    const workspace = snapshot.workspaces.find((row) => row.id === spec.workspaceId);
    const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
    if (
      !workspace ||
      !binding ||
      binding.executionTargetId !== input.targetId ||
      spec.execution.targetId !== input.targetId
    )
      throw new Error("External session target no longer matches catalog");
    const scope: WorkspaceNavigationScope = {
      workspaceId: workspace.id,
      targetId: input.targetId,
      workspaceIdentity: workspace.workspaceIdentity,
      workspacePath: workspace.worktreePath,
    };
    const capability = await input.host.getSessionCapabilities(spec);
    // 中文：路径可能复用；只有目标签发的原始 generation 与当前绑定、project 和身份一致才可执行。
    const current =
      workspace.lifecycle === "active" &&
      workspace.projectId === spec.projectId &&
      binding.projectId === spec.projectId &&
      workspace.worktreeGeneration === spec.execution.worktreeGeneration &&
      scope.workspaceIdentity === spec.execution.workspaceIdentity &&
      scope.workspacePath === spec.execution.worktreePath;
    return {
      kind: "external",
      scope: current
        ? scope
        : {
            ...scope,
            workspaceIdentity: spec.execution.workspaceIdentity,
            workspacePath: spec.execution.worktreePath,
          },
      spec,
      historyOnly: !current || capability.text.support !== "supported",
    };
  };
  const pending = new Map<
    string,
    { intent: string; result: ReturnType<IWorkspaceHierarchyService["createAgent"]> }
  >();
  const createAgentOnce = async (
    request: Parameters<IWorkspaceHierarchyService["createAgent"]>[0],
  ) => {
    if (!request.commandId?.trim()) throw new Error("Stable creation command ID required");
    const snapshot = await input.catalog.sidebarSnapshot();
    const workspace = snapshot.workspaces.find((row) => row.id === request.workspaceId);
    const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
    const project = snapshot.projects.find((row) => row.id === workspace?.projectId);
    if (!workspace || !binding || !project || binding.executionTargetId !== input.targetId)
      throw new Error("Unknown target workspace");
    const scope = await scopeFor(workspace.id);
    if (!scope) throw new Error("Workspace scope changed");
    if (request.harnessId === "zcode") {
      if (!input.native) throw new Error("Native V4 owner unavailable");
      if (
        !input.newAdmissionsEnabled() ||
        project.archived ||
        workspace.archived ||
        workspace.lifecycle !== "active"
      )
        throw new Error("New native admission unavailable");
      const result = await input.native.create({
        scope,
        commandId: request.commandId,
        modelBinding: request.modelBinding,
        cwdRelativeToWorktree: request.cwdRelativeToWorktree ?? ".",
      });
      return {
        owner: {
          kind: "native" as const,
          scope,
          originalSessionId: result.originalSessionId,
          historyOnly: false,
        },
      };
    }
    const receipt = await input.host.queryCreationCommand(request.commandId);
    if (receipt) {
      if (
        receipt.spec.workspaceId !== workspace.id ||
        receipt.spec.harness.id !== request.harnessId ||
        JSON.stringify(receipt.spec.modelBinding) !== JSON.stringify(request.modelBinding) ||
        receipt.spec.execution.cwdRelativeToWorktree !== (request.cwdRelativeToWorktree ?? ".")
      )
        throw new Error("Creation command ID belongs to another intent");
      if (receipt.receipt.status !== "completed")
        throw new Error("Creation outcome is uncertain; query receipt");
      return {
        owner: await ownerForSpec(receipt.spec),
        snapshot: await input.host.snapshot(receipt.spec),
      };
    }
    if (
      !input.newAdmissionsEnabled() ||
      project.archived ||
      workspace.archived ||
      workspace.lifecycle !== "active"
    )
      throw new Error("New admission unavailable");
    const entry = (await input.host.catalogForTarget(scope.targetId)).find(
      (row) => row.manifest.id === request.harnessId,
    );
    if (!entry || entry.availability !== "supported")
      throw new Error("Untrusted or unavailable harness");
    const spec = deriveWritableSessionSpec({
      hostSessionId: randomUUID(),
      projectId: project.id,
      workspaceId: workspace.id,
      binding,
      workspace,
      expectedTargetId: input.targetId,
      expectedGeneration: workspace.worktreeGeneration,
      cwdRelativeToWorktree: request.cwdRelativeToWorktree,
      harness: { id: entry.manifest.id, adapterVersion: entry.manifest.adapterVersion },
      modelBinding: request.modelBinding,
    });
    const result = await input.host.create(spec, request.commandId);
    return { owner: await ownerForSpec(spec), snapshot: result };
  };
  return {
    async resolveWorkspace(request) {
      if (request.targetId !== input.targetId) return undefined;
      const snapshot = await input.catalog.sidebarSnapshot();
      const matches = snapshot.workspaces.filter((workspace) => {
        const binding = snapshot.bindings.find((row) => row.id === workspace.repositoryBindingId);
        return (
          binding?.executionTargetId === request.targetId &&
          workspace.worktreePath === request.workspacePath &&
          workspace.workspaceIdentity ===
            (request.workspaceIdentity?.trim() || request.workspacePath)
        );
      });
      if (matches.length !== 1) return undefined;
      const scope = await scopeFor(matches[0]!.id);
      if (!scope) return undefined;
      if (!request.remoteSessionId) return scope;
      // 中文：仅认证 registry 可以关联 attachment；同路径或客户端提供的 ID 不能证明归属。
      const trusted = await input.resolveRemoteSession?.(scope.workspaceIdentity);
      return trusted === request.remoteSessionId
        ? { ...scope, remoteSessionId: trusted }
        : undefined;
    },
    async resolveOwner(request) {
      if (request.targetId !== input.targetId) return undefined;
      const scope = await scopeFor(request.workspaceId);
      if (!scope) return undefined;
      const spec = await input.host.getSessionSpec({
        targetId: request.targetId,
        workspaceId: request.workspaceId,
        hostSessionId: request.sessionId,
      });
      const found = await input.native?.resolveOwner(request);
      if (spec && found) throw new Error("Ambiguous native/external session ID");
      if (spec) return ownerForSpec(spec);
      if (!found) return undefined;
      const snapshot = await input.catalog.sidebarSnapshot();
      const workspace = snapshot.workspaces.find((row) => row.id === request.workspaceId);
      const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
      // 中文：原生旧索引若缺少 generation/仓库绑定证明，不能按相同路径重新关联到新 worktree 执行。
      const current =
        !!workspace &&
        !!binding &&
        workspace.lifecycle === "active" &&
        binding.executionTargetId === input.targetId &&
        binding.projectId === workspace.projectId &&
        found.worktreeGeneration === workspace.worktreeGeneration &&
        found.repositoryBindingId === binding.id &&
        found.workspaceIdentity === workspace.workspaceIdentity;
      // Native IDs are not tree aliases. Preserve the exact source scope used by V4 transport.
      return {
        kind: "native",
        originalSessionId: found.originalSessionId,
        historyOnly: !current,
        scope: {
          ...scope,
          workspacePath: found.sourceWorkspacePath,
          workspaceIdentity: found.workspaceIdentity,
          ...(found.remoteSessionId ? { remoteSessionId: found.remoteSessionId } : {}),
        },
      };
    },
    async previewRemoval(request) {
      const snapshot = await input.catalog.sidebarSnapshot();
      const workspace = snapshot.workspaces.find((row) => row.id === request.workspaceId);
      const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
      if (
        !workspace ||
        !binding ||
        binding.projectId !== workspace.projectId ||
        binding.executionTargetId !== input.targetId
      )
        throw new Error("Unknown target workspace");
      if (workspace.worktreeGeneration !== request.expectedGeneration)
        throw new Error("stale-workspace");
      // 中文：只委托现有 Catalog/Target 预检；确认时 Target 仍须独立冻结和重查，不依赖 UI 预检结果。
      return input.catalog.previewRemoval(workspace.id, request.expectedGeneration);
    },
    async pendingRecovery(request) {
      const scope = await scopeFor(request.workspaceId);
      if (!scope) throw new Error("Unknown target workspace");
      return {
        workspaceId: request.workspaceId,
        status: "unresolved",
        reason: "target-receipts-unavailable",
        actions: ["inspect"],
      };
    },
    async listHarnesses(workspaceId) {
      const scope = await scopeFor(workspaceId);
      if (!scope) throw new Error("Unknown target workspace");
      const external = await input.host.catalogForTarget(scope.targetId);
      return [
        {
          manifest: {
            schemaVersion: 1 as const,
            id: "zcode",
            name: "ZCode",
            adapterVersion: "native-v4",
            icon: nativeHarnessAssetMetadata.zcode?.icon,
          },
          availability: input.native ? ("supported" as const) : ("unknown" as const),
          ...(!input.native ? { reason: "native owner not attached" } : {}),
        },
        ...external,
      ];
    },
    createAgent(request) {
      const intent = JSON.stringify([
        request.workspaceId,
        request.harnessId,
        request.modelBinding,
        request.cwdRelativeToWorktree ?? ".",
      ]);
      const flight = pending.get(request.commandId);
      if (flight) {
        if (flight.intent !== intent)
          throw new Error("Creation command ID belongs to another intent");
        return flight.result;
      }
      const result = createAgentOnce(request);
      pending.set(request.commandId, { intent, result });
      void result
        .finally(() => {
          if (pending.get(request.commandId)?.result === result) pending.delete(request.commandId);
        })
        .catch(() => undefined);
      return result;
    },
    capabilities(owner) {
      if (owner.scope.targetId !== input.targetId) throw new Error("Foreign target");
      return owner.kind === "external"
        ? input.host.getSessionCapabilities(owner.spec)
        : input.native
          ? input.native.capabilities(owner)
          : Promise.reject(new Error("Native V4 owner unavailable"));
    },
    asset: resolveHarnessAsset,
  };
}
