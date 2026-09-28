import { createHash } from "node:crypto";
import { relative, isAbsolute, resolve, sep } from "node:path";
import {
  sessionHierarchyFileSchema,
  sessionHierarchyRecordSchema,
  type SessionHierarchyFile,
} from "@zcode/shared/agent-host/session-hierarchy";
import type { LegacySessionLocator, AdoptedWorktreeLocator } from "../contract.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  if (value === undefined) return "undefined";
  return JSON.stringify(value);
}

function stableSort<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => {
    const leftKey = stableJson(left);
    const rightKey = stableJson(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function hash(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function hierarchyId(
  ownerKind: string,
  targetId: string,
  workspaceIdentity: string,
  harnessId: string,
  sourceKey: string,
  nativeSessionId: string,
): string {
  const bytes = createHash("sha256")
    .update(
      stableJson([ownerKind, targetId, workspaceIdentity, harnessId, sourceKey, nativeSessionId]),
    )
    .digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function buildSessionHierarchyPreview(
  locators: readonly LegacySessionLocator[],
  workspaces: readonly AdoptedWorktreeLocator[],
  targetId: string,
  knownHarnessIds?: readonly string[],
): SessionHierarchyFile {
  const sorted = stableSort(locators);
  const fingerprint = hash({
    version: 1,
    targetId,
    knownHarnessIds: stableSort(knownHarnessIds ?? []),
    locators: sorted,
    workspaces: stableSort(workspaces),
  });
  const source = {
    sourceKey: `session-index:${targetId}`,
    fingerprint,
    commandKey: hash({ targetId, fingerprint, version: 1 }),
  };
  const records = sorted.map((locator) => {
    const ownerKind = locator.ownerKind ?? "native-v4";
    const target = locator.targetId?.trim() || "unknown-target";
    const resolvedWorktreePath = locator.resolvedWorktreePath ?? locator.workspacePath;
    const normalizedIdentity = locator.workspaceIdentity?.trim();
    const identity = normalizedIdentity || resolvedWorktreePath;
    const normalizedHarnessId = locator.harnessId?.trim();
    const harness = normalizedHarnessId || "unknown-harness";
    const id = hierarchyId(
      ownerKind,
      target,
      identity,
      harness,
      locator.sourceKey,
      locator.nativeSessionId,
    );
    const workspaceById = locator.workspaceId
      ? workspaces.find(
          (candidate) =>
            candidate.targetId === target && candidate.workspaceId === locator.workspaceId,
        )
      : undefined;
    const exactWorkspace = workspaces.find(
      (candidate) =>
        candidate.targetId === target &&
        Boolean(resolvedWorktreePath) &&
        candidate.worktreePath === resolvedWorktreePath &&
        (!locator.workspaceId || locator.workspaceId === candidate.workspaceId) &&
        (!locator.worktreeGeneration ||
          locator.worktreeGeneration === candidate.worktreeGeneration) &&
        (normalizedIdentity || resolvedWorktreePath) ===
          (candidate.workspaceIdentity?.trim() || candidate.worktreePath),
    );
    const pathWorkspace = resolvedWorktreePath
      ? workspaces.find(
          (candidate) =>
            candidate.targetId === target &&
            candidate.worktreePath === resolvedWorktreePath &&
            (normalizedIdentity || resolvedWorktreePath) ===
              (candidate.workspaceIdentity?.trim() || candidate.worktreePath),
        )
      : undefined;
    const workspace = exactWorkspace ?? workspaceById ?? pathWorkspace;
    const exactWorkspaceAssociation = Boolean(exactWorkspace);
    let status: "linked" | "pending-verification" = "linked";
    let pendingReason: SessionHierarchyFile["records"][number]["pendingReason"];
    if (locator.resolutionStatus === "nonGit") {
      status = "pending-verification";
      pendingReason = "nonGit";
    } else if (locator.resolutionStatus === "missing") {
      status = "pending-verification";
      pendingReason = "missing";
    } else if (!locator.targetId?.trim()) {
      status = "pending-verification";
      pendingReason = "target-unavailable";
    } else if (!workspace) {
      status = "pending-verification";
      pendingReason = "workspace-not-adopted";
    } else if (workspace.lifecycle === "archived") {
      status = "pending-verification";
      pendingReason = "workspace-archived";
    } else if (workspace.lifecycle === "missing") {
      status = "pending-verification";
      pendingReason = "missing";
    } else if (workspace.lifecycle === "removed") {
      status = "pending-verification";
      pendingReason = "workspace-removed";
    } else if (workspace.verification !== "verified") {
      status = "pending-verification";
      pendingReason = "needs-verification";
    } else if (
      // workspaceId 相同但 generation 已推进时，保留旧归属供历史读取，不能套用新一代权限。
      workspaceById &&
      locator.worktreeGeneration &&
      locator.worktreeGeneration !== workspaceById.worktreeGeneration
    ) {
      status = "pending-verification";
      pendingReason = "stale-generation";
    } else if (workspaceById && !exactWorkspaceAssociation) {
      status = "pending-verification";
      pendingReason = "identity-mismatch";
    } else if (locator.ownerFactSource === "creation-receipt") {
      status = "pending-verification";
      pendingReason = "owner-state-unknown";
    } else if (
      knownHarnessIds &&
      (!normalizedHarnessId ||
        !knownHarnessIds.some((knownHarnessId) => knownHarnessId.trim() === normalizedHarnessId))
    ) {
      status = "pending-verification";
      pendingReason = "unknown-harness";
    } else if (workspace && !locator.cwd) {
      // Task index rows without a persisted cwd cannot be guessed as worktree root.
      status = "pending-verification";
      pendingReason = "cwd-unverified";
    } else if (ownerKind === "agent-host" && !locator.modelSelection && !locator.modelBindingKind) {
      // An external manifest without a binding kind is incomplete. Native
      // model state remains owned by the native session and is not required.
      status = "pending-verification";
      pendingReason = "locator-incomplete";
    }
    let cwdRelativeToWorktree: string | undefined;
    if (locator.cwd && workspace && exactWorkspaceAssociation) {
      const cwd = isAbsolute(locator.cwd)
        ? resolve(locator.cwd)
        : resolve(resolvedWorktreePath ?? workspace.worktreePath, locator.cwd);
      const cwdRoot = resolvedWorktreePath ?? workspace.worktreePath;
      const relativeCwd = relative(cwdRoot, cwd) || ".";
      if (
        relativeCwd === "." ||
        (!relativeCwd.startsWith(`..${sep}`) && relativeCwd !== ".." && !isAbsolute(relativeCwd))
      ) {
        cwdRelativeToWorktree = relativeCwd.split(sep).join("/");
      } else {
        if (status === "linked") {
          status = "pending-verification";
          pendingReason = "cwd-unverified";
        }
      }
    }
    return sessionHierarchyRecordSchema.parse({
      hierarchySessionId: id,
      nativeSessionId: locator.nativeSessionId,
      ownerKind,
      targetId: target,
      ...(workspace ? { projectId: workspace.projectId } : {}),
      ...(locator.workspaceId || workspace?.workspaceId
        ? { workspaceId: locator.workspaceId ?? workspace?.workspaceId }
        : {}),
      ...(normalizedHarnessId ? { harnessId: normalizedHarnessId } : {}),
      workspacePath: locator.workspacePath,
      ...(normalizedIdentity ? { workspaceIdentity: normalizedIdentity } : {}),
      ...(cwdRelativeToWorktree ? { cwdRelativeToWorktree } : {}),
      ...(locator.title ? { title: locator.title } : {}),
      ...(status === "linked" && workspace && locator.workspaceId && locator.worktreeGeneration
        ? {
            ownerAssociation: {
              workspaceId: locator.workspaceId,
              worktreeGeneration: locator.worktreeGeneration,
            },
          }
        : {}),
      ...(status === "pending-verification" && locator.workspaceId && locator.worktreeGeneration
        ? {
            ownerHistoryAssociation: {
              workspaceId: locator.workspaceId,
              worktreeGeneration: locator.worktreeGeneration,
            },
          }
        : {}),
      ...(locator.modelSelection ? { modelSelection: locator.modelSelection } : {}),
      status,
      ...(pendingReason ? { pendingReason } : {}),
    });
  });
  return sessionHierarchyFileSchema.parse({ schemaVersion: 1, source, records });
}
