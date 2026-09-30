import { createServiceLogger } from "../logger/serviceLogger.js";
import type { WorktreeWorkspace } from "./planTypes.js";
import { ProjectWorkspaceError } from "./errors.js";
import { discoverRepository } from "./discovery.js";
import type { ProjectWorkspaceDeps } from "./ports.js";

const logger = createServiceLogger("project-workspaces");

export interface RemovalPreview {
  workspaceId: string;
  generation: string;
  isMainWorktree: boolean;
  risks: {
    dirty: boolean;
    untracked: boolean;
    submodule: boolean;
    locked: boolean;
    externalWritersUnproven: true;
  };
  blockers: string[];
  spaceChecked: false;
}

export interface RemoveLinkedWorktreeInput {
  workspaceId: string;
  expectedGeneration: string;
  acknowledgeRisks: boolean;
  acknowledgeExternalWriters: boolean;
  stopConfirmed: boolean;
}

function parseStatus(stdout: string): { dirty: boolean; untracked: boolean } {
  let dirty = false;
  let untracked = false;
  for (const entry of stdout.split("\0")) {
    if (!entry) continue;
    if (entry.startsWith("??")) untracked = true;
    else dirty = true;
  }
  return { dirty, untracked };
}

export function createRemovalCommands(deps: ProjectWorkspaceDeps) {
  async function previewRemoval(workspaceId: string): Promise<RemovalPreview> {
    const snapshot = await deps.store.read();
    const workspace = snapshot.workspaces.find((item) => item.id === workspaceId);
    const binding = snapshot.bindings.find((item) => item.id === workspace?.repositoryBindingId);
    if (!workspace || !binding) throw new ProjectWorkspaceError("unknown-workspace");
    if (binding.executionTargetId !== deps.executionTargetId) {
      throw new ProjectWorkspaceError("foreign-target");
    }
    const blockers: string[] = [];
    if (workspace.isMainWorktree) blockers.push("main-worktree");
    const report = await discoverRepository(deps, workspace.worktreePath);
    if (report.kind === "scan-failed" || report.kind === "upgrade-required") {
      blockers.push(report.kind);
    }
    const listed =
      report.kind === "git" || report.kind === "bare"
        ? report.candidates.find((candidate) => candidate.worktreePath === workspace.worktreePath)
        : undefined;
    if (report.kind === "git" || report.kind === "bare") {
      if (!listed) blockers.push("not-listed");
    }
    const [status, submodule, activity] = await Promise.all([
      deps.git.run([
        "--git-dir",
        binding.gitCommonDir,
        "--work-tree",
        workspace.worktreePath,
        "status",
        "--porcelain=v1",
        "-z",
      ]),
      deps.git.run([
        "--git-dir",
        binding.gitCommonDir,
        "--work-tree",
        workspace.worktreePath,
        "submodule",
        "status",
        "--recursive",
      ]),
      deps.activity.inspect(workspaceId),
    ]);
    if (status.exitCode !== 0) blockers.push("status-unknown");
    const risks =
      status.exitCode === 0 ? parseStatus(status.stdout) : { dirty: false, untracked: false };
    if (activity === "unknown") blockers.push("activity-unknown");
    if (activity === "busy") blockers.push("activity-busy");
    if (activity === "approval") blockers.push("activity-approval");
    return {
      workspaceId,
      generation: workspace.worktreeGeneration,
      isMainWorktree: workspace.isMainWorktree,
      risks: {
        ...risks,
        submodule: submodule.exitCode !== 0 || submodule.stdout.trim().length > 0,
        locked: listed?.locked === true,
        externalWritersUnproven: true,
      },
      blockers,
      spaceChecked: false,
    };
  }

  return {
    previewRemoval,
    async removeLinkedWorktree(
      input: RemoveLinkedWorktreeInput,
    ): Promise<
      | { status: "removed"; workspace: WorktreeWorkspace }
      | { status: "rejected"; reasons: string[]; stoppedSessionIds: readonly string[] }
    > {
      const preview = await previewRemoval(input.workspaceId);
      const reasons = [...preview.blockers];
      if (preview.generation !== input.expectedGeneration) reasons.push("stale-generation");
      const hard = reasons.filter(
        (reason) => reason !== "activity-busy" && reason !== "activity-approval",
      );
      const needsStop = reasons.includes("activity-busy") || reasons.includes("activity-approval");
      if (hard.length > 0 || (needsStop && !input.stopConfirmed)) {
        logger.warn(undefined, "worktree-removal-rejected", {
          workspaceId: input.workspaceId,
          reasons,
        });
        return { status: "rejected", reasons, stoppedSessionIds: [] };
      }
      if (!input.acknowledgeRisks || !input.acknowledgeExternalWriters) {
        return {
          status: "rejected",
          reasons: ["acknowledgement-required"],
          stoppedSessionIds: [],
        };
      }
      await deps.store.update((snapshot) => {
        const workspace = snapshot.workspaces.find((item) => item.id === input.workspaceId);
        if (!workspace || workspace.worktreeGeneration !== input.expectedGeneration) {
          throw new ProjectWorkspaceError("stale-generation");
        }
        return {
          snapshot: {
            ...snapshot,
            deletionByWorkspaceId: {
              ...snapshot.deletionByWorkspaceId,
              [workspace.id]: { generation: workspace.worktreeGeneration },
            },
          },
          result: workspace,
        };
      });
      const clearFence = () =>
        deps.store.update((snapshot) => {
          const deletionByWorkspaceId = { ...snapshot.deletionByWorkspaceId };
          delete deletionByWorkspaceId[input.workspaceId];
          return { snapshot: { ...snapshot, deletionByWorkspaceId }, result: undefined };
        });
      try {
        if (needsStop) {
          const snapshot = await deps.store.read();
          const sessionIds = snapshot.sessions
            .filter((session) => session.workspaceId === input.workspaceId)
            .map((session) => session.id);
          await deps.activity.stopSessions(sessionIds);
        }
        const again = await deps.activity.inspect(input.workspaceId);
        if (again !== "idle") {
          await clearFence();
          return { status: "rejected", reasons: ["recheck-failed"], stoppedSessionIds: [] };
        }
        const snapshot = await deps.store.read();
        const workspace = snapshot.workspaces.find((item) => item.id === input.workspaceId);
        const binding = snapshot.bindings.find(
          (item) => item.id === workspace?.repositoryBindingId,
        );
        if (!workspace || !binding) throw new ProjectWorkspaceError("unknown-workspace");
        const removed = await deps.git.run([
          "-c",
          "core.hooksPath=/dev/null",
          "--git-dir",
          binding.gitCommonDir,
          "worktree",
          "remove",
          workspace.worktreePath,
        ]);
        if (removed.exitCode !== 0) {
          await clearFence();
          return { status: "rejected", reasons: ["git-remove-failed"], stoppedSessionIds: [] };
        }
        const workspaceRemoved = await deps.store.update((current) => {
          const currentWorkspace = current.workspaces.find((item) => item.id === input.workspaceId);
          if (!currentWorkspace) throw new ProjectWorkspaceError("unknown-workspace");
          const next: WorktreeWorkspace = { ...currentWorkspace, lifecycle: "removed" };
          const deletionByWorkspaceId = { ...current.deletionByWorkspaceId };
          delete deletionByWorkspaceId[next.id];
          return {
            snapshot: {
              ...current,
              workspaces: current.workspaces.map((item) => (item.id === next.id ? next : item)),
              deletionByWorkspaceId,
            },
            result: next,
          };
        });
        logger.info(undefined, "worktree-removed", { workspaceId: workspaceRemoved.id });
        return { status: "removed", workspace: workspaceRemoved };
      } catch (error) {
        await clearFence();
        throw error;
      }
    },
  };
}
