import {
  resolveWorkspaceAdmissionKey,
  workspaceAdmissionFenceSchema,
  type WorkspaceAdmissionFence,
} from "@zcode/shared/agent-host";
import type { WorktreeWorkspaceRecord } from "../contract.js";
import type {
  WorkspaceAdmissionFencePort,
  WorkspaceAdmissionController,
  WorktreeWorkspaceAdmissionRequest,
} from "./dependencies.js";

function fenceValue(
  targetId: string,
  workspace: WorktreeWorkspaceRecord,
  lifecycle: WorkspaceAdmissionFence["lifecycle"],
  extra: Pick<WorkspaceAdmissionFence, "freezeToken" | "previousLifecycle"> = {},
): WorkspaceAdmissionFence {
  return workspaceAdmissionFenceSchema.parse({
    schemaVersion: 1,
    targetId,
    workspaceId: workspace.id,
    workspaceKey: resolveWorkspaceAdmissionKey(workspace.workspaceIdentity, workspace.worktreePath),
    worktreePath: workspace.worktreePath,
    worktreeGeneration: workspace.worktreeGeneration,
    lifecycle,
    ...extra,
  });
}

export function createWorkspaceAdmissionController(input: {
  targetId: () => string;
  port: WorkspaceAdmissionFencePort;
}): WorkspaceAdmissionController {
  const targetId = () => {
    const value = input.targetId().trim();
    if (!value) throw new Error("target-id-required");
    return value;
  };
  const writeFence = (workspace: WorktreeWorkspaceRecord, next: WorkspaceAdmissionFence) =>
    input.port.writeFence(workspace, next);
  const setLifecycleLocked = async (
    workspace: WorktreeWorkspaceRecord,
    lifecycle: "active" | "archived",
  ) => {
    const current = await input.port.readFence(workspace);
    if (current && current.worktreeGeneration !== workspace.worktreeGeneration) {
      throw new Error("stale-worktree-generation");
    }
    if (current?.lifecycle === "frozen" || current?.lifecycle === "removed") {
      throw new Error(`workspace-admission-${current.lifecycle}`);
    }
    await writeFence(workspace, fenceValue(targetId(), workspace, lifecycle));
  };

  return {
    withWorkspace: (request, operation) => input.port.withWorkspace(request, operation),
    readFence: (workspace) => input.port.readFence(workspace),
    withFenceLock: (workspace, operation) => input.port.withFenceLock(workspace, operation),
    async register(workspace) {
      await input.port.withFenceLock(workspace, async () => {
        const current = await input.port.readFence(workspace);
        if (
          current?.worktreeGeneration === workspace.worktreeGeneration &&
          current.lifecycle === "frozen"
        ) {
          throw new Error("workspace-admission-frozen");
        }
        if (
          current?.worktreeGeneration === workspace.worktreeGeneration &&
          current.lifecycle === "removed"
        ) {
          throw new Error("workspace-admission-removed");
        }
        await writeFence(
          workspace,
          fenceValue(
            targetId(),
            workspace,
            workspace.lifecycle === "archived" ? "archived" : "active",
          ),
        );
      });
    },
    async freeze(workspace, token, recovering) {
      await input.port.withFenceLock(workspace, async () => {
        const current = await input.port.readFence(workspace);
        if (
          current &&
          (current.targetId !== targetId() ||
            current.workspaceId !== workspace.id ||
            current.workspaceKey !==
              resolveWorkspaceAdmissionKey(workspace.workspaceIdentity, workspace.worktreePath) ||
            current.worktreePath !== workspace.worktreePath ||
            current.worktreeGeneration !== workspace.worktreeGeneration)
        ) {
          throw new Error("stale-worktree-generation");
        }
        if (current?.lifecycle === "frozen" && !recovering) {
          throw new Error("workspace-admission-frozen");
        }
        if (current?.lifecycle === "removed") throw new Error("workspace-admission-removed");
        const previousLifecycle =
          current?.lifecycle === "archived" ||
          (current?.lifecycle === "frozen" && current.previousLifecycle === "archived")
            ? "archived"
            : "active";
        await writeFence(
          workspace,
          fenceValue(targetId(), workspace, "frozen", {
            freezeToken: token,
            previousLifecycle,
          }),
        );
      });
    },
    async finishFreeze(workspace, token, lifecycle) {
      await input.port.withFenceLock(workspace, async () => {
        const current = await input.port.readFence(workspace);
        if (
          current?.lifecycle !== "frozen" ||
          current.freezeToken !== token ||
          current.worktreeGeneration !== workspace.worktreeGeneration
        ) {
          throw new Error("workspace-admission-freeze-token-stale");
        }
        await writeFence(workspace, fenceValue(targetId(), workspace, lifecycle));
      });
    },
    setLifecycleLocked,
  };
}
