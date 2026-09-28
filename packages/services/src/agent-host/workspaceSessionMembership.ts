import {
  resolveWorkspaceAdmissionKey,
  workspaceSessionOwnerLocatorSchema,
  workspaceSessionOwnersRequestSchema,
  workspaceSessionOwnersResultSchema,
  type WorkspaceSessionOwnerLocator,
  type WorkspaceSessionOwnersRequest,
  type WorkspaceSessionOwnersResult,
  type WorkspaceSessionModelBinding,
  type ExecutionTarget,
} from "@zcode/shared/agent-host";
import type { IWorktreeService } from "../projectWorkspaceServices.js";
import type { NativeWorkspaceSessionOwnerPort } from "./workspaceSessionService.js";
import { SessionHost } from "./sessionHost.js";
import { workspaceSessionLocatorFromSpec } from "./workspaceSessionProjection.js";
import type {
  WorkspaceSessionCreationReceipt,
  WorkspaceSessionReceiptStore,
} from "./workspaceSessionReceipts.js";

function receiptLocator(
  receipt: WorkspaceSessionCreationReceipt,
  currentWorkspace: { worktreePath: string } | undefined,
  queriedGeneration: string,
): WorkspaceSessionOwnerLocator | undefined {
  const path =
    receipt.workspacePath ??
    (receipt.worktreeGeneration === queriedGeneration &&
    currentWorkspace !== undefined &&
    receipt.workspaceIdentity === currentWorkspace.worktreePath
      ? currentWorkspace.worktreePath
      : undefined);
  if (!path) return undefined;
  const identity = receipt.workspacePath
    ? receipt.workspaceIdentity
    : receipt.workspaceIdentity === path
      ? undefined
      : receipt.workspaceIdentity;
  return {
    ownerKind: receipt.ownerKind,
    sessionId: receipt.ownerSessionId,
    targetId: receipt.targetId,
    workspaceId: receipt.workspaceId,
    worktreeGeneration: receipt.worktreeGeneration,
    ...(identity ? { workspaceIdentity: identity } : {}),
    workspacePath: path,
    harnessId: receipt.harnessId,
    ...(receipt.title ? { title: receipt.title } : {}),
    ownerFactSource: "creation-receipt",
  };
}

export function createWorkspaceSessionMembershipReader(options: {
  root: string;
  target: ExecutionTarget;
  worktrees?: IWorktreeService;
  nativeOwner?: NativeWorkspaceSessionOwnerPort;
  receipts: WorkspaceSessionReceiptStore;
}): {
  listWorkspaceSessionOwners(
    request: WorkspaceSessionOwnersRequest,
  ): Promise<WorkspaceSessionOwnersResult>;
} {
  return {
    async listWorkspaceSessionOwners(raw) {
      const request = workspaceSessionOwnersRequestSchema.parse(raw);
      const includeHistory = request.includeHistory === true;
      const catalog = options.worktrees ? await options.worktrees.read() : undefined;
      const workspace = catalog?.workspaces.find((item) => item.id === request.workspaceId);
      if (
        !includeHistory &&
        (!workspace || workspace.worktreeGeneration !== request.worktreeGeneration)
      ) {
        throw new Error("stale-or-unavailable-workspace");
      }

      const currentWorkspaceKey = workspace
        ? resolveWorkspaceAdmissionKey(workspace.workspaceIdentity, workspace.worktreePath)
        : undefined;
      let storedSessions: Awaited<ReturnType<typeof SessionHost.listStoredSessions>> = [];
      try {
        storedSessions = await SessionHost.listStoredSessions(options.root, {
          targetId: options.target.id,
        });
      } catch {
        // manifest 不可读时仍保留 receipt 创建事实，并明确投影为 unknown history。
      }
      const sessions: WorkspaceSessionOwnerLocator[] = [];
      const persistedOwnerIds = new Set<string>();
      for (const summary of storedSessions) {
        const spec = summary.spec;
        if (spec.execution.workspaceId !== request.workspaceId) continue;
        if (
          !includeHistory &&
          (spec.execution.worktreeGeneration !== request.worktreeGeneration ||
            !workspace ||
            spec.execution.workspaceIdentity !== currentWorkspaceKey ||
            spec.execution.worktreePath !== workspace.worktreePath)
        ) {
          continue;
        }
        persistedOwnerIds.add(`${spec.harness.id}\0${spec.hostSessionId}`);
        sessions.push({
          ...workspaceSessionLocatorFromSpec(spec, summary.title),
          ownerFactSource: "owner-index",
        });
      }

      let native:
        | readonly {
            sessionId: string;
            title?: string;
            modelBinding?: WorkspaceSessionModelBinding;
          }[]
        | undefined;
      if (options.nativeOwner && workspace) {
        try {
          native = await options.nativeOwner.list({
            targetId: options.target.id,
            workspaceId: workspace.id,
            worktreeGeneration: request.worktreeGeneration,
            workspacePath: workspace.worktreePath,
            workspaceIdentity: currentWorkspaceKey!,
          });
        } catch {
          // A confirmed receipt remains creation history when the owner index
          // cannot be read; it does not claim runtime state.
          native = undefined;
        }
      }
      const nativeIds = new Set<string>();
      if (native && workspace) {
        const explicitIdentity = workspace.workspaceIdentity?.trim();
        for (const session of native) {
          nativeIds.add(session.sessionId);
          sessions.push({
            ownerKind: "native-v4",
            sessionId: session.sessionId,
            targetId: options.target.id,
            workspaceId: workspace.id,
            worktreeGeneration: request.worktreeGeneration,
            ...(explicitIdentity ? { workspaceIdentity: explicitIdentity } : {}),
            workspacePath: workspace.worktreePath,
            harnessId: "zcode",
            ...(session.title ? { title: session.title } : {}),
            ...(session.modelBinding ? { modelBinding: session.modelBinding } : {}),
            ownerFactSource: "owner-index",
          });
        }
      }

      const receipts = await options.receipts.listCreatedHistory(
        options.target.id,
        request.workspaceId,
      );
      for (const receipt of receipts) {
        if (
          !includeHistory &&
          (receipt.worktreeGeneration !== request.worktreeGeneration ||
            !workspace ||
            (receipt.workspacePath !== undefined &&
              receipt.workspacePath !== workspace.worktreePath) ||
            (receipt.workspacePath
              ? resolveWorkspaceAdmissionKey(receipt.workspaceIdentity, receipt.workspacePath)
              : receipt.workspaceIdentity) !== currentWorkspaceKey)
        ) {
          continue;
        }
        const locator = receiptLocator(receipt, workspace, request.worktreeGeneration);
        if (!locator) continue;
        const owner =
          receipt.ownerKind === "native-v4"
            ? nativeIds.has(locator.sessionId)
            : persistedOwnerIds.has(`${locator.harnessId}\0${locator.sessionId}`);
        sessions.push(
          workspaceSessionOwnerLocatorSchema.parse({
            ...locator,
            ...(owner ? { ownerFactSource: "owner-index" as const } : {}),
          }),
        );
      }

      const unique = new Map<string, WorkspaceSessionOwnerLocator>();
      for (const session of sessions) {
        const key = `${session.ownerKind}\0${session.targetId}\0${session.workspaceId}\0${session.worktreeGeneration}\0${session.workspacePath ?? ""}\0${session.workspaceIdentity ?? ""}\0${session.sessionId}`;
        const existing = unique.get(key);
        if (existing?.ownerFactSource === "owner-index") continue;
        unique.set(key, session);
      }
      return workspaceSessionOwnersResultSchema.parse({
        targetId: options.target.id,
        workspaceId: request.workspaceId,
        worktreeGeneration: request.worktreeGeneration,
        sessions: [...unique.values()],
      });
    },
  };
}
