/* oxlint-disable eslint(max-lines) -- Target/Catalog 原生 admission 与外部 Host 创建共享同一 scoped owner；拆分需保留并发 receipt 边界。 */
import { randomUUID } from "node:crypto";
import type { ProviderRegistryService } from "@zcode/provider";
import { createRegistryPiHarness } from "../agent-adapters/pi/createPiHarness.js";
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
  /** Certified original-ID allocator with durable create command receipt. */
  readonly certifiedCreate?: boolean;
  recover?(
    input: Parameters<NativeHierarchyPort["create"]>[0],
  ): Promise<{ originalSessionId: string } | undefined>;
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
    projectId: string;
    repositoryBindingId: string;
    worktreeGeneration: string;
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
  /** Production model catalog; absent in older test compositions means no certified choices. */
  registry?: ProviderRegistryService;
  native?: NativeHierarchyPort;
  newAdmissionsEnabled: () => boolean;
  /** Real Target receipt reader; absent legacy compositions do not invent a receipt. */
  recoveryFacts?: (
    workspaceId: string,
  ) => Promise<
    | { status: "confirmed"; generation: string; receiptKind: "adopt" | "create" | "remove" }
    | { status: "unresolved"; reason: "target-receipts-unavailable" | "target-result-unknown" }
  >;
  /** Core maintenance admission gates native create across the full async effect. */
  withNativeAdmission?: <T>(
    workspaceId: string,
    generation: string,
    cwd: string,
    action: () => Promise<T>,
  ) => Promise<T>;
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
      const nativeRequest = {
        scope,
        projectId: project.id,
        repositoryBindingId: binding.id,
        worktreeGeneration: workspace.worktreeGeneration,
        commandId: request.commandId,
        modelBinding: request.modelBinding,
        cwdRelativeToWorktree: request.cwdRelativeToWorktree ?? ".",
      };
      // 中文：已提交的完成收据重连是只读行为，不能因为新创建门禁关闭而重新分配 ID。
      const recovered = await input.native?.recover?.(nativeRequest);
      if (recovered) {
        // 中文：Core 原始 ID 的只读恢复无需重开创建 admission；可执行性仍须
        // Target 当下确认同代实例，Catalog 路径相等不能签发 writable owner。
        const target = await input.recoveryFacts?.(workspace.id);
        return {
          owner: {
            kind: "native" as const,
            scope,
            originalSessionId: recovered.originalSessionId,
            historyOnly:
              target?.status !== "confirmed" ||
              target.generation !== workspace.worktreeGeneration ||
              project.archived ||
              workspace.archived ||
              workspace.lifecycle !== "active",
          },
        };
      }
      if (!input.native?.certifiedCreate) throw new Error("Native V4 creation receipt unavailable");
      if (
        request.modelBinding.kind !== "host-managed" ||
        !input.registry?.validateSelection(request.modelBinding.selection).ok
      )
        throw new Error("Native model not in current Registry");
      if (
        !input.newAdmissionsEnabled() ||
        project.archived ||
        workspace.archived ||
        workspace.lifecycle !== "active"
      )
        throw new Error("New native admission unavailable");
      const runNative =
        input.withNativeAdmission ??
        (<T>(_workspaceId: string, _generation: string, _cwd: string, action: () => Promise<T>) =>
          action());
      const result = await runNative(
        workspace.id,
        workspace.worktreeGeneration,
        request.cwdRelativeToWorktree ?? ".",
        async () => {
          if (!input.newAdmissionsEnabled()) throw new Error("New native admission frozen");
          return input.native!.create(nativeRequest);
        },
      );
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
      const facts = await input.recoveryFacts?.(request.workspaceId);
      return {
        workspaceId: request.workspaceId,
        status: facts?.status ?? "unresolved",
        reason:
          facts?.status === "confirmed"
            ? "target-receipt-confirmed"
            : (facts?.reason ?? "target-receipts-unavailable"),
        ...(facts?.status === "confirmed"
          ? {
              generation: facts.generation,
              receiptKind: facts.receiptKind,
            }
          : {}),
        actions: ["inspect"] as const,
      };
    },
    async listHarnesses(workspaceId) {
      const scope = await scopeFor(workspaceId);
      if (!scope) throw new Error("Unknown target workspace");
      const external = await input.host.catalogForTarget(scope.targetId);
      let certified = false;
      if (input.native?.certifiedCreate) {
        try {
          const report = await input.native.capabilities({
            kind: "native",
            scope,
            originalSessionId: "",
            historyOnly: false,
          });
          certified =
            report.text.support === "supported" && report.hostManagedModel.support === "supported";
        } catch {
          /* old/changed CLI is unavailable, not an advertised native allocator */
        }
      }
      return [
        {
          manifest: {
            schemaVersion: 1 as const,
            id: "zcode",
            name: "ZCode",
            adapterVersion: "native-v4",
            icon: nativeHarnessAssetMetadata.zcode?.icon,
          },
          availability: certified ? ("supported" as const) : ("unknown" as const),
          ...(!certified ? { reason: "native creation receipt not certified" } : {}),
        },
        ...external,
      ];
    },
    async listCreateOptions(workspaceId) {
      const snapshot = await input.catalog.sidebarSnapshot();
      const workspace = snapshot.workspaces.find((row) => row.id === workspaceId);
      const scope = await scopeFor(workspaceId);
      if (!scope || !workspace || workspace.lifecycle !== "active" || workspace.archived)
        throw new Error("Unknown or inactive target workspace");
      const registry = input.registry;
      if (!registry)
        return { workspaceId, worktreeGeneration: workspace.worktreeGeneration, options: [] };
      await registry.start();
      const availability = await input.host.getAvailability();
      if (availability.target.id !== scope.targetId || !availability.target.available)
        throw new Error("Target unavailable for model selection");
      const certified = (await input.host.catalogForTarget(scope.targetId)).filter(
        (entry) => entry.availability === "supported" && entry.manifest.id === "pi",
      );
      // 中文：只探测已经在 Host 注册的生产 Pi adapter；未知/未认证的 Claude、ACP、Codex
      // 不从 Registry 模型表推导可执行选项，更不能把原生模型误绑到外部 Host。
      const pi = certified.length ? createRegistryPiHarness({ root: "", registry }) : undefined;
      const options: { harnessId: string; label: string; binding: ModelBindingRequest }[] = [];
      if (input.native?.certifiedCreate) {
        const capabilities = await input.native.capabilities({
          kind: "native",
          scope,
          originalSessionId: "",
          historyOnly: false,
        });
        if (
          capabilities.hostManagedModel.support === "supported" &&
          capabilities.text.support === "supported"
        ) {
          for (const provider of registry.listProviders())
            for (const model of provider.models) {
              for (const reasoningLevel of model.config.optionSpecs.reasoningLevel.values) {
                const selection = {
                  providerId: provider.providerId,
                  modelId: model.modelId,
                  options: { reasoningLevel },
                };
                if (!registry.validateSelection(selection).ok) continue;
                options.push({
                  harnessId: "zcode",
                  label: `${provider.providerName} / ${model.modelId} · ${reasoningLevel}`,
                  binding: { kind: "host-managed", selection },
                });
              }
            }
        }
      }
      if (pi) {
        for (const provider of registry.listProviders()) {
          for (const model of provider.models) {
            for (const reasoningLevel of model.config.optionSpecs.reasoningLevel.values) {
              const selection = {
                providerId: provider.providerId,
                modelId: model.modelId,
                options: { reasoningLevel },
              };
              if (
                !registry.validateSelection(selection).ok ||
                (await pi.hostManagedSupport(availability.target, selection)).support !==
                  "supported"
              )
                continue;
              options.push({
                harnessId: "pi",
                label: `${provider.providerName} / ${model.modelId} · ${reasoningLevel}`,
                binding: { kind: "host-managed", selection },
              });
            }
          }
        }
      }
      return { workspaceId, worktreeGeneration: workspace.worktreeGeneration, options };
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
