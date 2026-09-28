import { readFile } from "node:fs/promises";
import {
  atomicWritePrivateTextFile,
  withFileLock,
  workspaceAdmissionFenceFilePath,
  withWorkspaceAdmissionFence,
} from "@zcode/shared/node";
import { workspaceAdmissionFenceSchema } from "@zcode/shared/agent-host";
import type { WorktreeWorkspaceRecord } from "../contract.js";
import type {
  WorkspaceAdmissionFencePort,
  WorktreeWorkspaceAdmissionRequest,
} from "../app/dependencies.js";

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function createNodeWorkspaceAdmissionFencePort(input: {
  root: string;
  targetId: () => string;
}): WorkspaceAdmissionFencePort {
  const targetId = () => {
    const value = input.targetId().trim();
    if (!value) throw new Error("target-id-required");
    return value;
  };
  const pathFor = (workspace: WorktreeWorkspaceRecord) =>
    workspaceAdmissionFenceFilePath(
      input.root,
      targetId(),
      workspace.workspaceIdentity,
      workspace.worktreePath,
    );

  return {
    // root 在 Node 装配层绑定，再交给 shared fence；Worktree app 只持有 admission port。
    withWorkspace: async (request: WorktreeWorkspaceAdmissionRequest, operation) => {
      const ownerTargetId = targetId();
      if (request.targetId.trim() !== ownerTargetId) {
        throw new Error("workspace-admission-target-mismatch");
      }
      return withWorkspaceAdmissionFence(
        { ...request, targetId: ownerTargetId, root: input.root },
        operation,
      );
    },
    async readFence(workspace) {
      try {
        return workspaceAdmissionFenceSchema.parse(
          JSON.parse(await readFile(pathFor(workspace), "utf8")),
        );
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async writeFence(workspace, fence) {
      const checked = workspaceAdmissionFenceSchema.parse(fence);
      if (checked.targetId !== targetId()) throw new Error("workspace-admission-target-mismatch");
      await atomicWritePrivateTextFile(pathFor(workspace), `${JSON.stringify(checked, null, 2)}\n`);
    },
    withFenceLock: (workspace, operation) => withFileLock(pathFor(workspace), operation),
  };
}
