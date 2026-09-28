import { randomUUID } from "node:crypto";
import type { WorkspaceAdmissionFence } from "@zcode/shared/agent-host";
import {
  worktreeCatalogFileSchema,
  worktreeWorkspaceRecordSchema,
  type IWorktreeService,
  type WorkspaceActivityObservation,
  type WorktreeCatalogFile,
  type WorktreeDiscoveryResult,
  type WorktreeWorkspaceRecord,
} from "../contract.js";
import {
  workspaceRemovalPreviewSchema,
  workspaceRemovalRequestSchema,
  type WorkspaceRemovalBlocker,
} from "../removalContract.js";
import { equalEvidence } from "./evidence.js";
import type {
  WorktreeRemovalActivityPort,
  WorktreeServiceDependencies,
  WorkspaceAdmissionController,
} from "./dependencies.js";

type Mutate = <T>(
  mutator: (current: WorktreeCatalogFile) => { state: WorktreeCatalogFile; result: T },
) => Promise<T>;
type Discover = (path: string) => Promise<WorktreeDiscoveryResult>;

interface RemovalDependencies extends WorktreeServiceDependencies {
  admission?: WorkspaceAdmissionController;
  activity?: WorktreeRemovalActivityPort;
  discover: Discover;
  mutate: Mutate;
  read(): Promise<WorktreeCatalogFile>;
}

interface RemovalObservation {
  blockers: Set<WorkspaceRemovalBlocker>;
  recovery: boolean;
  risks: { dirty: boolean; untracked: boolean; submodule: boolean; locked: boolean };
}

interface Confirmation {
  workspaceId: string;
  expectedGeneration: string;
  recovery: boolean;
  expiresAt: number;
}

const REMOVAL_CONFIRMATION_TTL_MS = 5 * 60_000;

function missingPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function gitFailure(result: { stderr: string; exitCode: number }): Error {
  return new Error(result.stderr || `git-exit-${result.exitCode}`);
}

function addActivityBlockers(
  observation: WorkspaceActivityObservation,
  prefix: "native" | "external",
  blockers: Set<WorkspaceRemovalBlocker>,
): void {
  const pending =
    (observation.pendingCommandCount ?? 0) > 0 ||
    (observation.pendingInputCount ?? 0) > 0 ||
    (observation.activeTurnCount ?? 0) > 0;
  if (prefix === "external" && (observation.pendingApprovalCount ?? 0) > 0) {
    blockers.add("external-approval-pending");
  }
  if (
    observation.ownerPresent === false ||
    !observation.complete ||
    observation.state === "unknown"
  ) {
    blockers.add(`${prefix}-unknown` as WorkspaceRemovalBlocker);
  } else if (observation.state === "busy" || pending) {
    blockers.add(`${prefix}-busy` as WorkspaceRemovalBlocker);
  }
}

async function activityBlockers(
  activity: WorktreeRemovalActivityPort | undefined,
  workspace: WorktreeWorkspaceRecord,
): Promise<Set<WorkspaceRemovalBlocker>> {
  const blockers = new Set<WorkspaceRemovalBlocker>();
  if (!activity) {
    blockers.add("native-unknown");
    blockers.add("external-unknown");
    return blockers;
  }
  const [native, external] = await Promise.allSettled([
    activity.readNative(workspace),
    activity.readExternal(workspace),
  ]);
  if (native.status === "fulfilled") addActivityBlockers(native.value, "native", blockers);
  else blockers.add("native-unknown");
  if (external.status === "fulfilled") addActivityBlockers(external.value, "external", blockers);
  else blockers.add("external-unknown");
  return blockers;
}

function gateBlockers(
  fence: WorkspaceAdmissionFence | null,
  workspace: WorktreeWorkspaceRecord,
  expectedFreezeToken?: string,
  allowRecovery = false,
): Set<WorkspaceRemovalBlocker> {
  const blockers = new Set<WorkspaceRemovalBlocker>();
  if (!fence || fence.worktreeGeneration !== workspace.worktreeGeneration) {
    blockers.add("workspace-unverified");
  } else if (fence.lifecycle === "removed") {
    blockers.add("workspace-unavailable");
  } else if (
    fence.lifecycle === "frozen" &&
    (!expectedFreezeToken || fence.freezeToken !== expectedFreezeToken) &&
    !allowRecovery
  ) {
    blockers.add("workspace-frozen");
  }
  return blockers;
}

async function gitStatus(
  dependencies: WorktreeServiceDependencies,
  path: string,
  blockers: Set<WorkspaceRemovalBlocker>,
): Promise<{ dirty: boolean; untracked: boolean; submodule: boolean }> {
  const status = await dependencies.git.run([
    "-C",
    path,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  if (status.exitCode !== 0) {
    blockers.add("git-unavailable");
    return { dirty: false, untracked: false, submodule: false };
  }
  const entries = status.stdout.split("\0").filter(Boolean);
  const untracked = entries.some((entry) => entry.startsWith("??") || entry.startsWith("!!"));
  const dirty = entries.some((entry) => !entry.startsWith("??") && !entry.startsWith("!!"));
  if (dirty) blockers.add("dirty");
  if (untracked) blockers.add("untracked");

  const index = await dependencies.git.run(["-C", path, "ls-files", "--stage", "-z"]);
  if (index.exitCode !== 0) {
    blockers.add("git-unavailable");
    return { dirty, untracked, submodule: false };
  }
  const submodule = index.stdout.split("\0").some((entry) => entry.startsWith("160000 "));
  if (submodule) blockers.add("submodule");
  return { dirty, untracked, submodule };
}

async function inspectRemoval(
  dependencies: RemovalDependencies,
  workspace: WorktreeWorkspaceRecord,
  options: { recovering: boolean; expectedFreezeToken?: string },
): Promise<RemovalObservation> {
  const blockers = new Set<WorkspaceRemovalBlocker>();
  const risks = { dirty: false, untracked: false, submodule: false, locked: false };
  const binding = (await dependencies.read()).bindings.find(
    (candidate) => candidate.id === workspace.repositoryBindingId,
  );
  if (!binding || binding.executionTargetId !== dependencies.targetId().trim()) {
    blockers.add("workspace-unverified");
    return { blockers, recovery: false, risks };
  }
  if (workspace.isMainWorktree) blockers.add("main-worktree");
  if (workspace.verification !== "verified") blockers.add("workspace-unverified");
  const fence = (await dependencies.admission?.readFence(workspace)) ?? null;
  for (const blocker of gateBlockers(
    fence,
    workspace,
    options.expectedFreezeToken,
    options.recovering,
  )) {
    blockers.add(blocker);
  }

  let realPath: string | undefined;
  let pathIsMissing = false;
  try {
    realPath = await dependencies.filesystem.realpath(workspace.worktreePath);
    if (realPath !== workspace.worktreePath) blockers.add("workspace-unverified");
    const evidence = await dependencies.filesystem.identity(realPath);
    if (!equalEvidence(evidence, workspace.filesystemEvidence))
      blockers.add("workspace-unverified");
  } catch (error) {
    if (missingPath(error)) pathIsMissing = true;
    else blockers.add("workspace-unavailable");
  }
  const commonEvidence = await dependencies.filesystem
    .identity(binding.gitCommonDir)
    .catch(() => null);
  if (!commonEvidence || !equalEvidence(binding.commonDirEvidence, commonEvidence)) {
    blockers.add("workspace-unverified");
  }

  let discovery: WorktreeDiscoveryResult;
  try {
    discovery = await dependencies.discover(binding.gitCommonDir);
  } catch {
    blockers.add("git-unavailable");
    return { blockers, recovery: false, risks };
  }
  if (discovery.kind === "nonGit" || discovery.repositoryCommonDir !== binding.gitCommonDir) {
    blockers.add("git-unavailable");
    return { blockers, recovery: false, risks };
  }
  const candidate = discovery.candidates.find(
    (item) => item.worktreePath === workspace.worktreePath,
  );
  const recovery =
    options.recovering && fence?.lifecycle === "frozen" && candidate === undefined && pathIsMissing;
  if (fence?.lifecycle === "frozen" && !options.expectedFreezeToken && !recovery) {
    blockers.add("workspace-frozen");
  }
  if (!candidate) {
    if (!recovery) blockers.add("not-linked-worktree");
    return { blockers, recovery, risks };
  }
  if (!equalEvidence(candidate.commonDirEvidence, binding.commonDirEvidence)) {
    blockers.add("workspace-unverified");
  }
  if (candidate.isMainWorktree) blockers.add("main-worktree");
  if (candidate.locked) {
    risks.locked = true;
    blockers.add("locked");
  }
  if (pathIsMissing || !realPath) blockers.add("workspace-unavailable");
  const status = await gitStatus(dependencies, candidate.worktreePath, blockers);
  risks.dirty = status.dirty;
  risks.untracked = status.untracked;
  risks.submodule = status.submodule;
  return { blockers, recovery: false, risks };
}

function toPreview(
  workspace: WorktreeWorkspaceRecord,
  targetId: string,
  observation: RemovalObservation,
  token?: string,
) {
  return workspaceRemovalPreviewSchema.parse({
    workspaceId: workspace.id,
    targetId,
    expectedGeneration: workspace.worktreeGeneration,
    safeToRemove: observation.blockers.size === 0,
    blockers: [...observation.blockers],
    risks: observation.risks,
    externalProcessBoundary: "unmanaged-writers-not-enumerated",
    ...(token ? { confirmationToken: token } : {}),
  });
}

export function createWorkspaceRemoval(
  dependencies: RemovalDependencies,
): Pick<IWorktreeService, "previewRemoveWorkspace" | "removeWorkspace"> {
  const confirmations = new Map<string, Confirmation>();
  const expectedTarget = () => dependencies.targetId().trim();

  async function previewRemoveWorkspace(input: {
    workspaceId: string;
    expectedGeneration: string;
  }) {
    const workspace = (await dependencies.read()).workspaces.find(
      (item) => item.id === input.workspaceId,
    );
    if (!workspace) throw new Error(`unknown-workspace:${input.workspaceId}`);
    const stale = new Set<WorkspaceRemovalBlocker>();
    if (workspace.worktreeGeneration !== input.expectedGeneration) stale.add("stale-generation");
    const recovering = (await dependencies.admission?.readFence(workspace))?.lifecycle === "frozen";
    const observation = await inspectRemoval(dependencies, workspace, { recovering });
    for (const blocker of stale) observation.blockers.add(blocker);
    const owners = await activityBlockers(dependencies.activity, workspace);
    for (const blocker of owners) observation.blockers.add(blocker);
    let token: string | undefined;
    if (observation.blockers.size === 0) {
      token = randomUUID();
      confirmations.set(token, {
        workspaceId: workspace.id,
        expectedGeneration: workspace.worktreeGeneration,
        recovery: observation.recovery,
        expiresAt: Date.now() + REMOVAL_CONFIRMATION_TTL_MS,
      });
    }
    return toPreview(workspace, expectedTarget(), observation, token);
  }

  async function removeWorkspace(raw: unknown): Promise<WorktreeWorkspaceRecord> {
    const request = workspaceRemovalRequestSchema.parse(raw);
    const confirmation = confirmations.get(request.confirmationToken);
    confirmations.delete(request.confirmationToken);
    if (
      !confirmation ||
      confirmation.expiresAt < Date.now() ||
      confirmation.workspaceId !== request.workspaceId ||
      confirmation.expectedGeneration !== request.expectedGeneration
    ) {
      throw new Error("workspace-removal-confirmation-stale");
    }
    const workspace = (await dependencies.read()).workspaces.find(
      (item) => item.id === request.workspaceId,
    );
    if (!workspace || workspace.worktreeGeneration !== request.expectedGeneration) {
      throw new Error("stale-worktree-generation");
    }
    const admission = dependencies.admission;
    if (!admission) throw new Error("workspace-admission-owner-unavailable");
    const previousLifecycle = workspace.lifecycle === "archived" ? "archived" : "active";
    let gitRemovalConfirmed = confirmation.recovery;
    await admission.freeze(workspace, request.confirmationToken, confirmation.recovery);
    try {
      const ownerBlockers = await activityBlockers(dependencies.activity, workspace);
      if (ownerBlockers.size > 0) {
        throw new Error(`workspace-removal-blocked:${[...ownerBlockers].join(",")}`);
      }
      const removeUnderGitOperationLock = async () => {
        const finalCheck = await inspectRemoval(dependencies, workspace, {
          recovering: confirmation.recovery,
          expectedFreezeToken: request.confirmationToken,
        });
        if (finalCheck.blockers.size > 0) {
          throw new Error(`workspace-removal-blocked:${[...finalCheck.blockers].join(",")}`);
        }
        if (!confirmation.recovery) {
          const binding = (await dependencies.read()).bindings.find(
            (candidate) => candidate.id === workspace.repositoryBindingId,
          );
          if (!binding) throw new Error("workspace-binding-unavailable");
          const removed = await dependencies.git.run([
            "-C",
            binding.gitCommonDir,
            "worktree",
            "remove",
            workspace.worktreePath,
          ]);
          if (removed.exitCode !== 0) {
            const after = await inspectRemoval(dependencies, workspace, {
              recovering: true,
              expectedFreezeToken: request.confirmationToken,
            });
            if (!after.recovery) {
              throw new Error(`git-worktree-remove-failed:${gitFailure(removed).message}`);
            }
          }
          gitRemovalConfirmed = true;
        }

        const next = await dependencies.mutate((current) => {
          const stored = current.workspaces.find((item) => item.id === workspace.id);
          if (!stored || stored.worktreeGeneration !== request.expectedGeneration) {
            throw new Error("stale-worktree-generation");
          }
          const removed = worktreeWorkspaceRecordSchema.parse({
            ...stored,
            lifecycle: "removed",
            verification: "needsVerification",
          });
          return {
            state: worktreeCatalogFileSchema.parse({
              ...current,
              workspaces: current.workspaces.map((item) =>
                item.id === workspace.id ? removed : item,
              ),
            }),
            result: removed,
          };
        });
        await admission.finishFreeze(workspace, request.confirmationToken, "removed");
        return next;
      };
      return dependencies.operationLock
        ? await dependencies.operationLock(removeUnderGitOperationLock)
        : await removeUnderGitOperationLock();
    } catch (error) {
      // Git success followed by a catalog failure stays frozen; retry can reconcile from Git evidence.
      if (!gitRemovalConfirmed) {
        await admission
          .finishFreeze(workspace, request.confirmationToken, previousLifecycle)
          .catch(() => undefined);
      }
      throw error;
    }
  }

  return { previewRemoveWorkspace, removeWorkspace };
}
