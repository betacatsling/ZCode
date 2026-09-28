import type { WorkspaceAdmissionFence } from "@zcode/shared/agent-host";
import type {
  WorkspaceActivityObservation,
  WorktreeFilesystemPort,
  WorktreeGitExecPort,
  WorktreePersistence,
  WorktreeWorkspaceRecord,
} from "../contract.js";

export interface WorktreeRemovalActivityPort {
  readNative(workspace: WorktreeWorkspaceRecord): Promise<WorkspaceActivityObservation>;
  readExternal(workspace: WorktreeWorkspaceRecord): Promise<WorkspaceActivityObservation>;
}

export interface WorktreeWorkspaceAdmissionRequest {
  targetId: string;
  workspaceId?: string;
  workspaceIdentity?: string;
  workspacePath: string;
  expectedGeneration?: string;
}

/** Public application port for the shared native/external admission fence. */
export interface WorkspaceAdmissionFencePort {
  withWorkspace<T>(
    request: WorktreeWorkspaceAdmissionRequest,
    operation: () => Promise<T>,
  ): Promise<T>;
  readFence(workspace: WorktreeWorkspaceRecord): Promise<WorkspaceAdmissionFence | null>;
  writeFence(workspace: WorktreeWorkspaceRecord, fence: WorkspaceAdmissionFence): Promise<void>;
  withFenceLock<T>(workspace: WorktreeWorkspaceRecord, operation: () => Promise<T>): Promise<T>;
}

export interface WorkspaceAdmissionController {
  withWorkspace<T>(
    input: WorktreeWorkspaceAdmissionRequest,
    operation: () => Promise<T>,
  ): Promise<T>;
  readFence(workspace: WorktreeWorkspaceRecord): Promise<WorkspaceAdmissionFence | null>;
  register(workspace: WorktreeWorkspaceRecord): Promise<void>;
  withFenceLock<T>(workspace: WorktreeWorkspaceRecord, operation: () => Promise<T>): Promise<T>;
  freeze(workspace: WorktreeWorkspaceRecord, token: string, recovering: boolean): Promise<void>;
  finishFreeze(
    workspace: WorktreeWorkspaceRecord,
    token: string,
    lifecycle: "active" | "archived" | "removed",
  ): Promise<void>;
  setLifecycleLocked(
    workspace: WorktreeWorkspaceRecord,
    lifecycle: "active" | "archived",
  ): Promise<void>;
}

export interface WorktreeServiceDependencies {
  targetId: () => string;
  git: WorktreeGitExecPort;
  filesystem: WorktreeFilesystemPort;
  persistence: WorktreePersistence;
  admissionController?: WorkspaceAdmissionController;
  activity?: WorktreeRemovalActivityPort;
  operationLock?: <T>(task: () => Promise<T>) => Promise<T>;
  prepareHooksPath?: () => Promise<string>;
  idFactory?: () => string;
}

export function resolveTargetId(dependencies: WorktreeServiceDependencies): string {
  const id = dependencies.targetId().trim();
  if (!id) throw new Error("target-id-required");
  return id;
}
