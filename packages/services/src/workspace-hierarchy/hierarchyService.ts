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
  NativeCatalogRepairLease,
  NativeCatalogWorkspaceSnapshot,
} from "../project-workspaces/projectCatalog.js";
import type {
  IWorkspaceHierarchyService,
  SessionOwner,
  WorkspaceNavigationScope,
  WorkspaceAttachmentMetadata,
  CreateCommandInspection,
} from "./serviceContract.js";

/** Native V4 is the only authority for original session IDs, creation and capability truth. */
export interface NativeHierarchyPort {
  /** Certified original-ID allocator with durable create command receipt. */
  readonly certifiedCreate?: boolean;
  recover?(
    input: Parameters<NativeHierarchyPort["create"]>[0],
  ): Promise<{ originalSessionId: string; creationRemoteSessionId?: string } | undefined>;
  /** Never allocates: rechecks a completed CLI source certificate and fsyncs Core mapping only. */
  completeCertified?(
    commandId: string,
    expected: WorkspaceNavigationScope & {
      projectId: string;
      repositoryBindingId: string;
      worktreeGeneration: string;
    },
    beforeCommit: () => Promise<void>,
  ): Promise<{
    originalSessionId: string;
    intent: {
      targetId: string;
      projectId: string;
      workspaceId: string;
      repositoryBindingId: string;
      worktreeGeneration: string;
      workspaceIdentity: string;
      workspacePath: string;
      remoteSessionId?: string;
    };
  }>;
  inspect?(
    commandId: string,
    expected: WorkspaceNavigationScope,
  ): Promise<
    | { status: "unknown" | "pending" }
    | {
        status: "unavailable";
        diagnostic: { entryId: string; reason: "uncertified-mapping" };
      }
    | {
        status: "completed-unindexed";
        originalSessionId: string;
        diagnostic: { entryId: string; reason: "unreferenced-completion" };
      }
    | {
        status: "completed";
        originalSessionId: string;
        intent: {
          targetId: string;
          projectId: string;
          workspaceId: string;
          repositoryBindingId: string;
          worktreeGeneration: string;
          workspaceIdentity: string;
          workspacePath: string;
        };
      }
  >;
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
  create(
    input: {
      scope: WorkspaceNavigationScope;
      projectId: string;
      repositoryBindingId: string;
      worktreeGeneration: string;
      commandId: string;
      modelBinding: ModelBindingRequest;
      cwdRelativeToWorktree: string;
    },
    beforeWrite: () => Promise<void>,
  ): Promise<{ originalSessionId: string }>;
  capabilities(owner: Extract<SessionOwner, { kind: "native" }>): Promise<HarnessCapabilitiesV2>;
}

type NativeRecoveryFacts = (
  workspaceId: string,
) => Promise<
  | { status: "confirmed"; generation: string; receiptKind: "adopt" | "create" | "remove" }
  | { status: "unresolved"; reason: "target-receipts-unavailable" | "target-result-unknown" }
>;
type CatalogFactsReader = () => Promise<NativeCatalogWorkspaceSnapshot>;

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
  recoveryFacts?: NativeRecoveryFacts;
  /** Core maintenance admission gates native create across the full async effect. */
  withNativeAdmission?: <T>(
    workspaceId: string,
    generation: string,
    cwd: string,
    action: (lease: {
      recoveryFacts: NativeRecoveryFacts;
      catalog: NativeCatalogRepairLease;
    }) => Promise<T>,
  ) => Promise<T>;
  /** Authenticated window attachment registry, not an identity inferred from path. */
  resolveRemoteSession?: (workspaceIdentity: string) => Promise<string | undefined>;
}): IWorkspaceHierarchyService {
  const readCatalogFacts: CatalogFactsReader = () => input.catalog.sidebarSnapshot();
  const scopeFor = async (
    workspaceId: string,
    readFacts: CatalogFactsReader = readCatalogFacts,
  ): Promise<WorkspaceNavigationScope | undefined> => {
    const snapshot = await readFacts();
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
  const scopeWithAttachment = (
    scope: WorkspaceNavigationScope,
    attachment?: WorkspaceAttachmentMetadata,
  ): WorkspaceNavigationScope => {
    if (!attachment) return scope;
    // 中文：这是 Target 本地事实核对，不是远端 Registry 鉴权；当前 lease 只能由 Desktop 担保。
    if (
      attachment.workspacePath !== scope.workspacePath ||
      attachment.workspaceIdentity.trim() !== scope.workspaceIdentity ||
      !attachment.remoteSessionId.trim() ||
      !Number.isSafeInteger(attachment.generation) ||
      attachment.generation < 1
    )
      throw new Error("attachment scope does not match target workspace");
    return { ...scope, remoteSessionId: attachment.remoteSessionId };
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
  const inspectWithFacts = async (
    request: Parameters<IWorkspaceHierarchyService["inspectCreateCommand"]>[0],
    recoveryFacts: NativeRecoveryFacts | undefined = input.recoveryFacts,
    readFacts: CatalogFactsReader = readCatalogFacts,
  ): Promise<CreateCommandInspection> => {
    if (!request.commandId?.trim()) throw new Error("Stable creation command ID required");
    const scope = await scopeFor(request.workspaceId, readFacts);
    if (!scope) throw new Error("Unknown target workspace");
    const view = scopeWithAttachment(scope, request.attachment);
    const inspected = await input.native?.inspect?.(request.commandId, scope);
    if (!inspected) throw new Error("Native read-only inspection unavailable");
    if (inspected.status !== "completed") return inspected;
    const snapshot = await readFacts();
    const workspace = snapshot.workspaces.find((row) => row.id === request.workspaceId);
    const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
    const project = snapshot.projects.find((row) => row.id === workspace?.projectId);
    const { intent } = inspected;
    if (
      intent.targetId !== view.targetId ||
      intent.workspaceId !== view.workspaceId ||
      intent.workspaceIdentity !== view.workspaceIdentity ||
      intent.workspacePath !== view.workspacePath ||
      !binding ||
      !project ||
      intent.projectId !== project.id ||
      intent.repositoryBindingId !== binding.id
    )
      throw new Error("native-create-intent-conflict");
    const target = await recoveryFacts?.(workspace!.id);
    const current =
      target?.status === "confirmed" &&
      target.generation === workspace!.worktreeGeneration &&
      intent.worktreeGeneration === workspace!.worktreeGeneration &&
      !workspace!.archived &&
      workspace!.lifecycle === "active" &&
      !project.archived;
    return {
      status: "completed",
      owner: {
        kind: "native",
        scope: view,
        originalSessionId: inspected.originalSessionId,
        historyOnly: !current,
      },
    };
  };
  const reconcileCompleted = async (
    request: Parameters<IWorkspaceHierarchyService["reconcileCompletedCreateCommand"]>[0],
  ): Promise<CreateCommandInspection> => {
    const inspected = await inspectWithFacts(request);
    if (inspected.status !== "completed-unindexed") return inspected;
    const scope = await scopeFor(request.workspaceId);
    if (!scope) throw new Error("Unknown target workspace");
    scopeWithAttachment(scope, request.attachment);
    const snapshot = await input.catalog.sidebarSnapshot();
    const workspace = snapshot.workspaces.find((row) => row.id === scope.workspaceId);
    const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
    const project = snapshot.projects.find((row) => row.id === workspace?.projectId);
    const completeCertified = input.native?.completeCertified;
    if (!workspace || !binding || !project || !completeCertified || !input.withNativeAdmission)
      throw new Error("Native completed-only recovery admission unavailable");
    // 中文：完成来源修复需要持有 maintenance、Catalog 和 Target 三个同一 owner 的 admission，
    // 从来源证书到 mapping/reference fsync 与最终检查全部参与 maintenance drain。
    return input.withNativeAdmission(
      workspace.id,
      workspace.worktreeGeneration,
      ".",
      async (lease) => {
        const readLeaseFacts: CatalogFactsReader = async () => lease.catalog.snapshot();
        const fresh = await readLeaseFacts();
        const same = fresh.workspaces.find((row) => row.id === workspace.id);
        const sameBinding = fresh.bindings.find((row) => row.id === same?.repositoryBindingId);
        const sameProject = fresh.projects.find((row) => row.id === same?.projectId);
        if (
          !same ||
          same.worktreeGeneration !== workspace.worktreeGeneration ||
          same.workspaceIdentity !== scope.workspaceIdentity ||
          same.worktreePath !== scope.workspacePath ||
          sameBinding?.id !== binding.id ||
          sameProject?.id !== project.id ||
          sameBinding.executionTargetId !== scope.targetId
        )
          throw new Error("Native completion Catalog changed before repair");
        const inside = await inspectWithFacts(request, lease.recoveryFacts, readLeaseFacts);
        // 中文：同命令并发修复排队后若已提交，第二个只读返回同一原始 ID。
        if (
          inside.status === "completed" &&
          inside.owner.originalSessionId === inspected.originalSessionId
        )
          return inside;
        if (
          inside.status !== "completed-unindexed" ||
          inside.originalSessionId !== inspected.originalSessionId
        )
          throw new Error("Native completion changed before repair");
        const facts = await lease.recoveryFacts(workspace.id);
        // 中文：修复写入前重新检查 Target 和 Catalog；旧代完成事实只能留作历史，
        // 不能因新 attachment 或一次丢 ACK 就补写成当前代的可执行引用。
        if (facts?.status !== "confirmed" || facts.generation !== workspace.worktreeGeneration)
          throw new Error("Target generation unavailable for native completion repair");
        const completed = await completeCertified(
          request.commandId,
          {
            ...scope,
            projectId: project.id,
            repositoryBindingId: binding.id,
            worktreeGeneration: workspace.worktreeGeneration,
          },
          async () => {
            // 中文：SQLite 来源证明包含 await，必须在 mapping fsync 前再验 Target
            // 实例/owner 及 Catalog 绑定，而非只信进入租约时的快照。
            const now = await lease.recoveryFacts(workspace.id);
            const catalog = await readLeaseFacts();
            const row = catalog.workspaces.find((item) => item.id === workspace.id);
            if (
              now.status !== "confirmed" ||
              now.generation !== workspace.worktreeGeneration ||
              row?.worktreeGeneration !== workspace.worktreeGeneration ||
              row?.repositoryBindingId !== binding.id ||
              row?.workspaceIdentity !== scope.workspaceIdentity ||
              row?.worktreePath !== scope.workspacePath
            )
              throw new Error("Native completion target changed before mapping repair");
          },
        );
        if (
          completed.originalSessionId !== inspected.originalSessionId ||
          completed.intent.targetId !== scope.targetId ||
          completed.intent.workspaceId !== scope.workspaceId ||
          completed.intent.workspaceIdentity !== scope.workspaceIdentity ||
          completed.intent.workspacePath !== scope.workspacePath ||
          completed.intent.projectId !== project.id ||
          completed.intent.repositoryBindingId !== binding.id ||
          completed.intent.worktreeGeneration !== workspace.worktreeGeneration
        )
          throw new Error("native-create-intent-conflict");
        const current = await scopeFor(request.workspaceId, readLeaseFacts);
        const latest = await lease.recoveryFacts(request.workspaceId);
        if (
          !current ||
          current.targetId !== scope.targetId ||
          current.workspaceIdentity !== scope.workspaceIdentity ||
          current.workspacePath !== scope.workspacePath ||
          latest?.status !== "confirmed" ||
          latest.generation !== completed.intent.worktreeGeneration
        )
          throw new Error("Native completion target changed before Catalog repair");
        await lease.catalog.commitNativeReference({
          commandId: request.commandId,
          originalSessionId: completed.originalSessionId,
          targetId: scope.targetId,
          projectId: project.id,
          workspaceId: scope.workspaceId,
          repositoryBindingId: binding.id,
          worktreeGeneration: workspace.worktreeGeneration,
          workspaceIdentity: scope.workspaceIdentity,
          workspacePath: scope.workspacePath,
          ...(completed.intent.remoteSessionId
            ? { remoteSessionId: completed.intent.remoteSessionId }
            : {}),
        });
        const verified = await inspectWithFacts(request, lease.recoveryFacts, readLeaseFacts);
        if (
          verified.status !== "completed" ||
          verified.owner.originalSessionId !== inspected.originalSessionId
        )
          throw new Error("Native completion repair uncertain");
        return verified;
      },
    );
  };
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
    const catalogScope = await scopeFor(workspace.id);
    if (!catalogScope) throw new Error("Workspace scope changed");
    const scope = scopeWithAttachment(catalogScope, request.attachment);
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
      // 中文：旧 recover/commitReference 在门禁之前可能写 mapping 与 Catalog；
      // 先纯读验证原命令（含不可变模型/cwd），未引用完成只走共享修复 admission。
      const recovered = await input.native?.recover?.(nativeRequest);
      const inspection = input.native?.inspect
        ? await inspectWithFacts({
            workspaceId: workspace.id,
            commandId: request.commandId,
            attachment: request.attachment,
          })
        : undefined;
      if (inspection?.status === "completed-unindexed") {
        if (!recovered && !input.native?.completeCertified)
          throw new Error("Native completed receipt unavailable for repair");
        const repaired = await reconcileCompleted({
          workspaceId: workspace.id,
          commandId: request.commandId,
          attachment: request.attachment,
        });
        if (repaired.status !== "completed") throw new Error("Native completion repair uncertain");
        return { owner: repaired.owner };
      }
      if (inspection?.status === "completed") {
        if (!recovered || recovered.originalSessionId !== inspection.owner.originalSessionId)
          throw new Error("native-create-intent-conflict");
        return { owner: inspection.owner };
      }
      if (recovered || inspection?.status === "pending" || inspection?.status === "unavailable")
        throw new Error("native-create-receipt-uncertain");
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
      if (!input.withNativeAdmission)
        throw new Error("Native Target/Catalog admission unavailable");
      const result = await input.withNativeAdmission(
        workspace.id,
        workspace.worktreeGeneration,
        request.cwdRelativeToWorktree ?? ".",
        async (lease) => {
          if (!input.newAdmissionsEnabled()) throw new Error("New native admission frozen");
          // 中文：Catalog/Target 串行租约不能阻止外部替换 .git；在实际持久化边界重验真实实例。
          const revalidate = async () => {
            const now = await lease.recoveryFacts(workspace.id);
            const catalog = await lease.catalog.snapshot();
            const row = catalog.workspaces.find((item) => item.id === workspace.id);
            const currentBinding = catalog.bindings.find((item) => item.id === binding.id);
            const currentProject = catalog.projects.find((item) => item.id === project.id);
            if (
              now.status !== "confirmed" ||
              now.generation !== workspace.worktreeGeneration ||
              row?.worktreeGeneration !== workspace.worktreeGeneration ||
              row.repositoryBindingId !== binding.id ||
              row.projectId !== project.id ||
              row.workspaceIdentity !== scope.workspaceIdentity ||
              row.worktreePath !== scope.workspacePath ||
              row.lifecycle !== "active" ||
              row.archived ||
              currentBinding?.executionTargetId !== scope.targetId ||
              currentBinding.projectId !== project.id ||
              currentProject?.archived
            )
              throw new Error("Native create Target/Catalog scope changed");
          };
          await revalidate();
          const created = await input.native!.create(nativeRequest, revalidate);
          // 中文：mapping 后、引用 fsync 前仍可能有外部 Git 实例变化。
          await revalidate();
          await lease.catalog.commitNativeReference({
            commandId: request.commandId,
            originalSessionId: created.originalSessionId,
            targetId: scope.targetId,
            projectId: project.id,
            workspaceId: workspace.id,
            repositoryBindingId: binding.id,
            worktreeGeneration: workspace.worktreeGeneration,
            workspaceIdentity: scope.workspaceIdentity,
            workspacePath: scope.workspacePath,
            ...(scope.remoteSessionId ? { remoteSessionId: scope.remoteSessionId } : {}),
          });
          return created;
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
      // 中文：旧 attachment ID 只是创建时来源；重连后必须由当前认证 registry
      // 再证明 scope，否则不得仅凭原路径/旧 lease 发放可写 owner。
      const currentAttachment = found.remoteSessionId
        ? await input.resolveRemoteSession?.(found.workspaceIdentity)
        : undefined;
      // 中文：原生旧索引若缺少 generation/仓库绑定证明，不能按相同路径重新关联到新 worktree 执行。
      const current =
        !!workspace &&
        !!binding &&
        workspace.lifecycle === "active" &&
        binding.executionTargetId === input.targetId &&
        binding.projectId === workspace.projectId &&
        found.worktreeGeneration === workspace.worktreeGeneration &&
        found.repositoryBindingId === binding.id &&
        found.workspaceIdentity === workspace.workspaceIdentity &&
        (!found.remoteSessionId || currentAttachment === found.remoteSessionId);
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
    inspectCreateCommand: (request) => inspectWithFacts(request),
    reconcileCompletedCreateCommand: (request) => reconcileCompleted(request),
    createAgent(request) {
      const intent = JSON.stringify([
        request.workspaceId,
        request.harnessId,
        request.modelBinding,
        request.cwdRelativeToWorktree ?? ".",
        // 中文：view generation 不属于稳定命令意图，重连后的有效 scope 可以只读查询原命令。
        request.attachment?.workspaceIdentity.trim() || "",
        request.attachment?.workspacePath || "",
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
