export * from "./contract.js";
export * from "./removalContract.js";
export type { IWorktreeBareRepositoryAdoptionService } from "./bareRepositoryAdoptionContract.js";
export { createWorktreeService } from "./app/worktreeService.js";
export type {
  WorkspaceAdmissionController,
  WorkspaceAdmissionFencePort,
  WorktreeServiceDependencies,
  WorktreeWorkspaceAdmissionRequest,
} from "./app/dependencies.js";
export { createFileWorktreePersistence } from "./adapters/fileWorktreePersistence.js";
export { nodeWorktreeFilesystem } from "./adapters/nodeFilesystem.js";
export { nodeWorktreeGitExec } from "./adapters/nodeGitExec.js";

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { withFileLock } from "@zcode/shared/node";
import type { IWorktreeService } from "./contract.js";
import { createWorktreeService } from "./app/worktreeService.js";
import type { WorktreeServiceDependencies } from "./app/dependencies.js";
import { createFileWorktreePersistence } from "./adapters/fileWorktreePersistence.js";
import { nodeWorktreeFilesystem } from "./adapters/nodeFilesystem.js";
import { nodeWorktreeGitExec } from "./adapters/nodeGitExec.js";
import { createNodeWorkspaceAdmissionFencePort } from "./adapters/nodeWorkspaceAdmissionFence.js";
import { createWorkspaceAdmissionController as createWorkspaceAdmissionControllerApp } from "./app/admissionFence.js";
import type {
  WorkspaceAdmissionController,
  WorktreeRemovalActivityPort,
} from "./app/dependencies.js";

export function createFileWorktreeService(options: {
  filePath: string;
  targetId: () => string;
  git?: WorktreeServiceDependencies["git"];
  filesystem?: WorktreeServiceDependencies["filesystem"];
  activity?: WorktreeRemovalActivityPort;
  admissionRoot?: string;
  admissionController?: WorktreeServiceDependencies["admissionController"];
  persistence?: WorktreeServiceDependencies["persistence"];
  idFactory?: () => string;
}): IWorktreeService {
  const admissionRoot = options.admissionRoot ?? `${options.filePath}.admission`;
  return createWorktreeService({
    targetId: options.targetId,
    git: options.git ?? nodeWorktreeGitExec,
    filesystem: options.filesystem ?? nodeWorktreeFilesystem,
    persistence: options.persistence ?? createFileWorktreePersistence(options.filePath),
    admissionController:
      options.admissionController ??
      createNodeWorkspaceAdmissionController({ root: admissionRoot, targetId: options.targetId }),
    activity: options.activity,
    operationLock: (task) => withFileLock(`${options.filePath}.operations`, task),
    prepareHooksPath: async () => {
      const hooksPath = join(dirname(options.filePath), ".worktree-hooks");
      await mkdir(hooksPath, { recursive: true, mode: 0o700 });
      return hooksPath;
    },
    idFactory: options.idFactory,
  });
}

export function createNodeWorkspaceAdmissionController(options: {
  root: string;
  targetId: () => string;
}): WorkspaceAdmissionController {
  return createWorkspaceAdmissionControllerApp({
    targetId: options.targetId,
    port: createNodeWorkspaceAdmissionFencePort(options),
  });
}

/** @deprecated Use the explicit Node composition name. */
export const createWorkspaceAdmissionController = createNodeWorkspaceAdmissionController;
export type { WorktreeRemovalActivityPort } from "./app/dependencies.js";
