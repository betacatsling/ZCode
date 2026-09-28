import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { managedNativeWorkspaceSessionId } from "@zcode/shared/node";
import {
  externalSessionCreateResultSchema,
  externalSessionLocatorFromSpec,
  externalWorkspaceSessionCreateRequestSchema,
  managedWorkspaceSessionAssociationSchema,
  sessionSpecSchema,
  workspaceSessionCreateRequestSchema,
  workspaceSessionCreateResultSchema,
  type ExecutionTarget,
  type ExternalWorkspaceSessionCreateRequest,
  type ExternalSessionCreateResult,
  type ManagedWorkspaceSessionAssociation,
  type SessionSpec,
  type WorkspaceSessionBindingCapabilityRequest,
  type WorkspaceSessionBindingCapabilityResult,
  type WorkspaceSessionCreateRequest,
  type WorkspaceSessionCreateResult,
  type WorkspaceSessionModelBinding,
  type WorkspaceSessionOwnersRequest,
  type WorkspaceSessionOwnersResult,
  resolveWorkspaceAdmissionKey,
} from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { IWorktreeService } from "../projectWorkspaceServices.js";
import type { HarnessRegistry } from "./harnessRegistry.js";
import type { ModelCatalogPort } from "./modelBindingPlanner.js";
import { SessionHost } from "./sessionHost.js";
import { createWorkspaceSessionMembershipReader } from "./workspaceSessionMembership.js";
import { createWorkspaceSessionCapabilityReader } from "./workspaceSessionCapability.js";
import type { WorkspaceSessionReceiptStore } from "./workspaceSessionReceipts.js";
import {
  externalWorkspaceSessionId,
  workspaceSessionRequestFingerprint,
} from "./workspaceSessionIdentity.js";
import {
  workspaceSessionLocatorFromNative,
  workspaceSessionLocatorFromSpec,
} from "./workspaceSessionProjection.js";

export type WorkspaceAdmissionRunner = <T>(
  spec: SessionSpec,
  operation: () => Promise<T>,
) => Promise<T>;

export interface NativeWorkspaceSessionOwnerPort {
  lookup(input: {
    targetId: string;
    sessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<{
    sessionId: string;
    association: ManagedWorkspaceSessionAssociation | null;
    workspacePath: string;
    workspaceIdentity?: string;
    title: string;
  } | null>;
  create(input: {
    association: ManagedWorkspaceSessionAssociation;
    workspacePath: string;
    workspaceIdentity: string;
    selection: ModelSelection;
    title?: string;
  }): Promise<{ sessionId: string; reused: boolean }>;
  list(input: {
    targetId: string;
    workspaceId: string;
    worktreeGeneration: string;
    workspacePath: string;
    workspaceIdentity: string;
  }): Promise<
    | readonly {
        sessionId: string;
        title?: string;
        modelBinding?: WorkspaceSessionModelBinding;
      }[]
    | undefined
  >;
}

export type WorkspaceAdmissionFenceChecker = (workspace: {
  id: string;
  workspacePath: string;
  workspaceIdentity?: string;
  worktreeGeneration: string;
}) => Promise<void>;

export interface WorkspaceSessionServiceOptions {
  root: string;
  target: ExecutionTarget;
  catalog: ModelCatalogPort;
  registry: HarnessRegistry;
  worktrees?: IWorktreeService;
  nativeOwner?: NativeWorkspaceSessionOwnerPort;
  receipts: WorkspaceSessionReceiptStore;
  checkAdmissionFence?: WorkspaceAdmissionFenceChecker;
  createExternal(spec: SessionSpec): Promise<ConversationSnapshot>;
  createManagedExternal(
    spec: SessionSpec,
    receipt: { requestId: string; requestFingerprint: string },
    title?: string,
  ): Promise<boolean>;
}

export function createWorkspaceSessionService(options: WorkspaceSessionServiceOptions): {
  getWorkspaceSessionCapability(
    request: WorkspaceSessionBindingCapabilityRequest,
  ): Promise<WorkspaceSessionBindingCapabilityResult>;
  createExternalForWorkspace(
    request: ExternalWorkspaceSessionCreateRequest,
  ): Promise<ExternalSessionCreateResult>;
  createWorkspaceSession(
    request: WorkspaceSessionCreateRequest,
  ): Promise<WorkspaceSessionCreateResult>;
  listWorkspaceSessionOwners(
    request: WorkspaceSessionOwnersRequest,
  ): Promise<WorkspaceSessionOwnersResult>;
} {
  const membership = createWorkspaceSessionMembershipReader(options);
  const getWorkspaceSessionCapability = createWorkspaceSessionCapabilityReader({
    target: options.target,
    catalog: options.catalog,
    registry: options.registry,
    hasNativeOwner: Boolean(options.nativeOwner),
  });
  async function requireCurrentWorkspace(request: WorkspaceSessionCreateRequest) {
    if (!options.target.available) throw new Error("execution-target-unavailable");
    if (!options.worktrees) throw new Error("target worktree owner unavailable");
    const availability = await options.worktrees.getAvailability();
    if (!availability.available || availability.targetId !== options.target.id) {
      throw new Error("execution-target-unavailable");
    }
    const catalog = await options.worktrees.read();
    const workspace = catalog.workspaces.find((item) => item.id === request.workspaceId);
    if (
      !workspace ||
      workspace.worktreeGeneration !== request.worktreeGeneration ||
      workspace.lifecycle !== "active" ||
      workspace.verification !== "verified"
    ) {
      throw new Error("stale-or-unavailable-workspace");
    }
    const revalidated = await options.worktrees.revalidate(workspace.id);
    if (
      revalidated.status !== "verified" ||
      revalidated.workspace.id !== workspace.id ||
      revalidated.workspace.worktreeGeneration !== request.worktreeGeneration ||
      revalidated.workspace.worktreePath !== workspace.worktreePath ||
      revalidated.workspace.lifecycle !== "active"
    ) {
      throw new Error("workspace-filesystem-evidence-stale");
    }
    if (!isAbsolute(workspace.worktreePath)) throw new Error("workspace-path-not-absolute");
    const canonicalPath = await realpath(workspace.worktreePath);
    if (canonicalPath !== workspace.worktreePath) throw new Error("workspace-path-replaced");
    if (!(await stat(workspace.worktreePath)).isDirectory()) {
      throw new Error("workspace-path-not-directory");
    }
    return workspace;
  }

  return {
    getWorkspaceSessionCapability,
    async createExternalForWorkspace(raw) {
      const request = externalWorkspaceSessionCreateRequestSchema.parse(raw);
      if (!options.worktrees) throw new Error("target worktree owner unavailable");
      const catalog = await options.worktrees.read();
      const workspace = catalog.workspaces.find((item) => item.id === request.workspaceId);
      if (
        !workspace ||
        workspace.worktreeGeneration !== request.worktreeGeneration ||
        workspace.lifecycle !== "active" ||
        workspace.verification !== "verified"
      ) {
        throw new Error("stale-or-unavailable-workspace");
      }
      const workspaceKey = resolveWorkspaceAdmissionKey(
        workspace.workspaceIdentity,
        workspace.worktreePath,
      );
      const spec = sessionSpecSchema.parse({
        schemaVersion: 1,
        hostSessionId: request.hostSessionId,
        execution: {
          targetId: options.target.id,
          workspaceIdentity: workspaceKey,
          worktreePath: workspace.worktreePath,
          workspaceId: workspace.id,
          worktreeGeneration: workspace.worktreeGeneration,
        },
        harness: request.harness,
        modelBinding: request.modelBinding,
      });
      const snapshot = await options.createExternal(spec);
      return externalSessionCreateResultSchema.parse({
        locator: externalSessionLocatorFromSpec(spec),
        snapshot,
      });
    },
    async createWorkspaceSession(raw) {
      const request = workspaceSessionCreateRequestSchema.parse(raw);
      const workspace = await requireCurrentWorkspace(request);
      const workspaceKey = resolveWorkspaceAdmissionKey(
        workspace.workspaceIdentity,
        workspace.worktreePath,
      );
      const workspaceIdentity = workspace.workspaceIdentity?.trim() || undefined;
      const fingerprint = workspaceSessionRequestFingerprint(options.target.id, request);
      const ownerKind = request.harnessId === "zcode" ? "native-v4" : "agent-host";
      const nativeOwner = options.nativeOwner;
      const checkAdmissionFence = options.checkAdmissionFence;
      if (ownerKind === "native-v4" && request.modelBinding.kind !== "native-selection") {
        throw new Error("native-workspace-session-requires-native-selection");
      }
      if (ownerKind === "agent-host" && request.modelBinding.kind === "native-selection") {
        throw new Error("external-workspace-session-requires-external-model-binding");
      }
      const ownerSessionId =
        ownerKind === "native-v4"
          ? managedNativeWorkspaceSessionId(options.target.id, request.requestId)
          : externalWorkspaceSessionId(options.target.id, request.requestId);
      const receipt = await options.receipts.reserve({
        targetId: options.target.id,
        requestId: request.requestId,
        requestFingerprint: fingerprint,
        workspaceId: workspace.id,
        worktreeGeneration: workspace.worktreeGeneration,
        workspaceIdentity,
        workspacePath: workspace.worktreePath,
        harnessId: request.harnessId,
        ownerKind,
        ownerSessionId,
        ...(request.title ? { title: request.title } : {}),
      });

      if (receipt.state === "created" && ownerKind === "native-v4") {
        const receiptWorkspacePath =
          receipt.workspacePath ??
          (receipt.workspaceIdentity === workspace.worktreePath
            ? workspace.worktreePath
            : undefined);
        if (!receiptWorkspacePath) {
          // 旧 receipt 未保存原路径且 key 不等于当前 path 时，不能把重建目录冒充 owner cwd。
          throw new Error("workspace-session-create-receipt-path-unknown");
        }
        const association = managedWorkspaceSessionAssociationSchema.parse({
          targetId: receipt.targetId,
          workspaceId: receipt.workspaceId,
          worktreeGeneration: receipt.worktreeGeneration,
          requestId: receipt.requestId,
          requestFingerprint: receipt.requestFingerprint,
        });
        return workspaceSessionCreateResultSchema.parse({
          locator: workspaceSessionLocatorFromNative(
            {
              sessionId: receipt.ownerSessionId,
              association,
              workspacePath: receiptWorkspacePath,
              workspaceIdentity: receipt.workspaceIdentity,
              ...(receipt.title ? { title: receipt.title } : {}),
            },
            request.modelBinding,
          ),
          reused: true,
        });
      }

      if (ownerKind === "agent-host") {
        const existingManifest = await SessionHost.findStoredCreation(
          options.root,
          options.target.id,
          request.requestId,
        );
        if (existingManifest) {
          if (existingManifest.requestFingerprint !== fingerprint) {
            throw new Error("workspace-session-idempotency-conflict");
          }
          if (receipt.state !== "created") {
            await options.receipts.markCreated(options.target.id, request.requestId, fingerprint);
          }
          return workspaceSessionCreateResultSchema.parse({
            locator: workspaceSessionLocatorFromSpec(existingManifest.spec, existingManifest.title),
            reused: true,
          });
        }
        if (receipt.state === "created") {
          throw new Error("workspace-session-create-receipt-manifest-missing");
        }
      }

      if (ownerKind === "native-v4") {
        if (request.modelBinding.kind !== "native-selection") {
          throw new Error("native-workspace-session-requires-native-selection");
        }
        if (!nativeOwner) throw new Error("native-workspace-session-owner-unavailable");
        if (!checkAdmissionFence) throw new Error("workspace-admission-owner-unavailable");
        await checkAdmissionFence({
          id: workspace.id,
          workspacePath: workspace.worktreePath,
          ...(workspace.workspaceIdentity
            ? { workspaceIdentity: workspace.workspaceIdentity }
            : {}),
          worktreeGeneration: workspace.worktreeGeneration,
        });
        const association = managedWorkspaceSessionAssociationSchema.parse({
          targetId: options.target.id,
          workspaceId: workspace.id,
          worktreeGeneration: workspace.worktreeGeneration,
          requestId: request.requestId,
          requestFingerprint: fingerprint,
        });
        const created = await nativeOwner.create({
          association,
          workspacePath: workspace.worktreePath,
          workspaceIdentity: workspaceKey,
          selection: request.modelBinding.selection,
          ...(request.title ? { title: request.title } : {}),
        });
        if (created.sessionId !== receipt.ownerSessionId) {
          throw new Error("workspace-session-owner-id-mismatch");
        }
        await options.receipts.markCreated(options.target.id, request.requestId, fingerprint);
        return workspaceSessionCreateResultSchema.parse({
          locator: {
            ownerKind: "native-v4",
            sessionId: created.sessionId,
            targetId: options.target.id,
            workspaceId: workspace.id,
            worktreeGeneration: workspace.worktreeGeneration,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            workspacePath: workspace.worktreePath,
            harnessId: "zcode",
            ...(request.title ? { title: request.title } : {}),
            modelBinding: request.modelBinding,
          },
          reused: created.reused,
        });
      }
      const harness = options.registry.require(request.harnessId);
      const spec = sessionSpecSchema.parse({
        schemaVersion: 1,
        hostSessionId: receipt.ownerSessionId,
        execution: {
          targetId: options.target.id,
          workspaceIdentity: workspaceKey,
          worktreePath: workspace.worktreePath,
          workspaceId: workspace.id,
          worktreeGeneration: workspace.worktreeGeneration,
        },
        harness: { id: request.harnessId, adapterVersion: harness.version },
        modelBinding: request.modelBinding,
      });
      const reused = await options.createManagedExternal(
        spec,
        { requestId: request.requestId, requestFingerprint: fingerprint },
        request.title,
      );
      await options.receipts.markCreated(options.target.id, request.requestId, fingerprint);
      return workspaceSessionCreateResultSchema.parse({
        locator: workspaceSessionLocatorFromSpec(spec, request.title),
        reused,
      });
    },
    listWorkspaceSessionOwners: (request) => membership.listWorkspaceSessionOwners(request),
  };
}
