import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  resolveWorkspaceAdmissionKey,
  workspaceAdmissionFenceSchema,
} from "../agent-host/workspace-admission.js";
import { acquireFileLock } from "./atomicFileLock.js";

const LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;

export type WorkspaceAdmissionFenceErrorCode =
  | "workspace-admission-unmanaged"
  | "workspace-admission-identity-mismatch"
  | "workspace-admission-stale-generation"
  | "workspace-admission-archived"
  | "workspace-admission-frozen"
  | "workspace-admission-removed";

export class WorkspaceAdmissionFenceError extends Error {
  constructor(readonly code: WorkspaceAdmissionFenceErrorCode) {
    super(code);
    this.name = "WorkspaceAdmissionFenceError";
  }
}

export interface WorkspaceAdmissionFenceRequest {
  root: string;
  targetId: string;
  workspaceId?: string;
  workspaceIdentity?: string;
  workspacePath: string;
  expectedGeneration?: string;
}

export function workspaceAdmissionFenceFilePath(
  root: string,
  targetId: string,
  workspaceIdentity: string | undefined,
  workspacePath: string,
): string {
  const workspaceKey = resolveWorkspaceAdmissionKey(workspaceIdentity, workspacePath);
  const hash = createHash("sha256").update(`${targetId}\0${workspaceKey}`).digest("hex");
  return join(root, `${hash}.json`);
}

/** Serialize the authoritative admission decision with a target Worktree freeze. */
export async function withWorkspaceAdmissionFence<T>(
  request: WorkspaceAdmissionFenceRequest,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireWorkspaceAdmissionFence(request);
  try {
    return await operation();
  } finally {
    await release();
  }
}

export async function acquireWorkspaceAdmissionFence(
  request: WorkspaceAdmissionFenceRequest,
): Promise<() => Promise<void>> {
  const fencePath = workspaceAdmissionFenceFilePath(
    request.root,
    request.targetId,
    request.workspaceIdentity,
    request.workspacePath,
  );
  await mkdir(dirname(fencePath), { recursive: true });
  const release = await acquireFileLock(fencePath, LOCK_RETRY_DELAYS_MS, 100, 8_000);
  try {
    let text: string;
    try {
      text = await readFile(fencePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (request.expectedGeneration) {
        throw new WorkspaceAdmissionFenceError("workspace-admission-unmanaged");
      }
      return release;
    }
    const fence = workspaceAdmissionFenceSchema.parse(JSON.parse(text));
    const expectedKey = resolveWorkspaceAdmissionKey(
      request.workspaceIdentity,
      request.workspacePath,
    );
    if (
      fence.targetId !== request.targetId ||
      fence.workspaceKey !== expectedKey ||
      fence.worktreePath !== request.workspacePath ||
      (request.workspaceId !== undefined && fence.workspaceId !== request.workspaceId)
    ) {
      throw new WorkspaceAdmissionFenceError("workspace-admission-identity-mismatch");
    }
    if (!request.expectedGeneration || request.expectedGeneration !== fence.worktreeGeneration) {
      throw new WorkspaceAdmissionFenceError("workspace-admission-stale-generation");
    }
    if (fence.lifecycle === "archived") {
      throw new WorkspaceAdmissionFenceError("workspace-admission-archived");
    }
    if (fence.lifecycle === "frozen") {
      throw new WorkspaceAdmissionFenceError("workspace-admission-frozen");
    }
    if (fence.lifecycle === "removed") {
      throw new WorkspaceAdmissionFenceError("workspace-admission-removed");
    }
    return release;
  } catch (error) {
    await release();
    throw error;
  }
}
