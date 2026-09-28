import { randomUUID } from "node:crypto";
import {
  bareRepositoryAdoptionRequestSchema,
  repositoryBindingRecordSchema,
  worktreeCandidateSchema,
  type IWorktreeService,
  type WorktreeAdoption,
  type WorktreeCandidate,
  type WorktreeCatalogFile,
  type WorktreeRevalidation,
  type WorktreeAvailability,
  type BareRepositoryAdoptionRequest,
  type RepositoryBindingRecord,
} from "../contract.js";
import { parseWorktreeCatalog, emptyWorktreeCatalogFile } from "../domain/state.js";
import { worktreeCatalogFileSchema, worktreeWorkspaceRecordSchema } from "../contract.js";
import { createWorktreeDiscoverer } from "./discovery.js";
import { type WorktreeServiceDependencies, resolveTargetId } from "./dependencies.js";
import {
  equalEvidence,
  preserveLifecycle,
  sameEvidenceRecord,
  titleForCandidate,
} from "./evidence.js";
import { createWorkspaceMutations } from "./workspaceMutations.js";
import { createWorkspaceRemoval } from "./removal.js";

export function createWorktreeService(dependencies: WorktreeServiceDependencies): IWorktreeService {
  const idFactory = dependencies.idFactory ?? randomUUID;
  const discover = createWorktreeDiscoverer(dependencies);
  const admission = dependencies.admissionController;
  let writeQueue: Promise<unknown> = Promise.resolve();

  const enqueueWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const queued = writeQueue.then(task, task) as Promise<T>;
    writeQueue = queued.catch(() => undefined);
    return queued;
  };

  async function read(): Promise<WorktreeCatalogFile> {
    await writeQueue;
    const raw = await dependencies.persistence.read();
    return raw === null ? emptyWorktreeCatalogFile() : parseWorktreeCatalog(raw);
  }

  async function getAvailability(): Promise<WorktreeAvailability> {
    return {
      targetId: resolveTargetId(dependencies),
      available: true,
      writable: true,
    };
  }

  async function mutate<T>(
    mutator: (current: WorktreeCatalogFile) => { state: WorktreeCatalogFile; result: T },
  ): Promise<T> {
    return enqueueWrite(async () => {
      let result!: T;
      await dependencies.persistence.update((raw) => {
        const current = raw === null ? emptyWorktreeCatalogFile() : parseWorktreeCatalog(raw);
        const mutation = mutator(current);
        result = mutation.result;
        return parseWorktreeCatalog(mutation.state);
      });
      return result;
    });
  }

  async function adopt(
    projectId: string,
    candidate: WorktreeCandidate,
    title?: string,
  ): Promise<WorktreeAdoption> {
    const expectedTarget = resolveTargetId(dependencies);
    if (candidate.targetId !== expectedTarget) throw new Error("foreign-target-candidate");
    const checkedInput = worktreeCandidateSchema.parse(candidate);
    const currentDiscovery = await discover(checkedInput.worktreePath);
    if (currentDiscovery.kind !== "git") throw new Error("candidate-is-no-longer-git");
    const checkedCandidate = currentDiscovery.candidates.find(
      (item) =>
        item.worktreePath === checkedInput.worktreePath &&
        item.repositoryCommonDir === checkedInput.repositoryCommonDir &&
        equalEvidence(item.filesystemEvidence, checkedInput.filesystemEvidence) &&
        equalEvidence(item.commonDirEvidence, checkedInput.commonDirEvidence),
    );
    if (!checkedCandidate) throw new Error("stale-or-foreign-worktree-candidate");
    const result = await mutate((current) => {
      let binding = current.bindings.find(
        (item) =>
          item.executionTargetId === expectedTarget &&
          item.gitCommonDir === checkedCandidate.repositoryCommonDir,
      );
      if (binding && binding.projectId !== projectId) throw new Error("binding-project-mismatch");
      if (
        binding &&
        !equalEvidence(binding.commonDirEvidence, checkedCandidate.commonDirEvidence)
      ) {
        throw new Error("binding-needs-verification");
      }
      if (!binding) {
        binding = repositoryBindingRecordSchema.parse({
          schemaVersion: 1,
          id: idFactory(),
          projectId,
          executionTargetId: expectedTarget,
          gitCommonDir: checkedCandidate.repositoryCommonDir,
          commonDirEvidence: checkedCandidate.commonDirEvidence,
        });
      }
      const existing = current.workspaces.find(
        (item) =>
          item.repositoryBindingId === binding!.id &&
          item.worktreePath === checkedCandidate.worktreePath,
      );
      if (existing) {
        if (existing.lifecycle === "removed") {
          throw new Error("workspace-removed-requires-explicit-reverify");
        }
        if (!equalEvidence(existing.filesystemEvidence, checkedCandidate.filesystemEvidence)) {
          throw new Error("workspace-needs-verification");
        }
        const existingBinding = current.bindings.find((item) => item.id === binding!.id)!;
        return { state: current, result: { binding: existingBinding, workspace: existing } };
      }
      const workspace = worktreeWorkspaceRecordSchema.parse({
        schemaVersion: 1,
        id: idFactory(),
        projectId,
        repositoryBindingId: binding.id,
        title: title?.trim() || titleForCandidate(checkedCandidate),
        worktreePath: checkedCandidate.worktreePath,
        worktreeGeneration: idFactory(),
        isMainWorktree: checkedCandidate.isMainWorktree,
        head: checkedCandidate.head,
        origin: "adopted",
        lifecycle: "active",
        verification: "verified",
        filesystemEvidence: checkedCandidate.filesystemEvidence,
      });
      const state = worktreeCatalogFileSchema.parse({
        ...current,
        bindings: current.bindings.some((item) => item.id === binding!.id)
          ? current.bindings.map((item) => (item.id === binding!.id ? binding : item))
          : [...current.bindings, binding],
        workspaces: [...current.workspaces, workspace],
      });
      return { state, result: { binding, workspace } };
    });
    await admission?.register(result.workspace);
    return result;
  }

  async function adoptBareRepository(
    projectId: string,
    rawRequest: BareRepositoryAdoptionRequest,
  ): Promise<RepositoryBindingRecord> {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) throw new Error("project-id-required");
    const request = bareRepositoryAdoptionRequestSchema.parse(rawRequest);
    const expectedTarget = resolveTargetId(dependencies);
    if (request.targetId !== expectedTarget) throw new Error("foreign-target-bare-repository");

    const adoptUnderOperationLock = async (): Promise<RepositoryBindingRecord> => {
      const discovery = await discover(request.inputPath);
      if (discovery.kind !== "bare") throw new Error("repository-is-no-longer-bare");
      if (
        discovery.targetId !== expectedTarget ||
        discovery.repositoryCommonDir !== request.repositoryCommonDir ||
        !equalEvidence(discovery.commonDirEvidence, request.commonDirEvidence)
      ) {
        throw new Error("stale-bare-repository-evidence");
      }
      return mutate((current) => {
        let binding = current.bindings.find(
          (item) =>
            item.executionTargetId === expectedTarget &&
            item.gitCommonDir === discovery.repositoryCommonDir,
        );
        if (binding && binding.projectId !== normalizedProjectId) {
          throw new Error("binding-project-mismatch");
        }
        if (binding && !equalEvidence(binding.commonDirEvidence, discovery.commonDirEvidence)) {
          throw new Error("binding-needs-verification");
        }
        if (!binding) {
          binding = repositoryBindingRecordSchema.parse({
            schemaVersion: 1,
            id: idFactory(),
            projectId: normalizedProjectId,
            executionTargetId: expectedTarget,
            gitCommonDir: discovery.repositoryCommonDir,
            commonDirEvidence: discovery.commonDirEvidence,
          });
          return {
            state: worktreeCatalogFileSchema.parse({
              ...current,
              bindings: [...current.bindings, binding],
            }),
            result: binding,
          };
        }
        return { state: current, result: binding };
      });
    };
    return dependencies.operationLock
      ? dependencies.operationLock(adoptUnderOperationLock)
      : adoptUnderOperationLock();
  }

  const workspaceMutations = createWorkspaceMutations({
    ...dependencies,
    discover,
    enqueueWrite,
    mutate,
    idFactory,
  });

  async function revalidate(
    workspaceId: string,
    options: { acceptRebuild?: boolean } = {},
  ): Promise<WorktreeRevalidation> {
    const current = await read();
    const workspace = current.workspaces.find((item) => item.id === workspaceId);
    if (!workspace) throw new Error(`unknown-workspace:${workspaceId}`);
    const binding = current.bindings.find((item) => item.id === workspace.repositoryBindingId);
    if (!binding) throw new Error(`invalid-binding:${workspace.repositoryBindingId}`);
    const discovery = await discover(workspace.worktreePath);
    const assertFreshObservation = (state: WorktreeCatalogFile) => {
      const stored = state.workspaces.find((item) => item.id === workspaceId);
      const currentBinding = state.bindings.find((item) => item.id === binding.id);
      if (
        !stored ||
        !currentBinding ||
        stored.lifecycle !== workspace.lifecycle ||
        stored.worktreeGeneration !== workspace.worktreeGeneration ||
        !sameEvidenceRecord(stored.filesystemEvidence, workspace.filesystemEvidence) ||
        !sameEvidenceRecord(currentBinding.commonDirEvidence, binding.commonDirEvidence)
      ) {
        throw new Error("stale-worktree-observation");
      }
      return { stored, currentBinding };
    };
    if (discovery.kind !== "git") {
      return mutate<WorktreeRevalidation>((state) => {
        const { stored, currentBinding } = assertFreshObservation(state);
        const next = worktreeWorkspaceRecordSchema.parse({
          ...stored,
          lifecycle: preserveLifecycle(
            stored,
            discovery.kind === "nonGit" && discovery.reason === "missing-path"
              ? "missing"
              : "active",
          ),
          verification: "needsVerification",
        });
        const nextState = worktreeCatalogFileSchema.parse({
          ...state,
          workspaces: state.workspaces.map((item) => (item.id === workspaceId ? next : item)),
        });
        return {
          state: nextState,
          result: {
            status: next.lifecycle === "missing" ? "missing" : "needsVerification",
            binding: currentBinding,
            workspace: next,
          },
        };
      });
    }
    const candidate = discovery.candidates.find(
      (item) => item.worktreePath === workspace.worktreePath,
    );
    const same =
      candidate &&
      discovery.repositoryCommonDir === binding.gitCommonDir &&
      equalEvidence(candidate.filesystemEvidence, workspace.filesystemEvidence) &&
      equalEvidence(discovery.commonDirEvidence, binding.commonDirEvidence);
    const canConfirmEvidence =
      candidate !== undefined &&
      candidate.filesystemEvidence.device !== null &&
      candidate.filesystemEvidence.inode !== null &&
      candidate.filesystemEvidence.birthtimeMs !== null &&
      discovery.commonDirEvidence.device !== null &&
      discovery.commonDirEvidence.inode !== null &&
      discovery.commonDirEvidence.birthtimeMs !== null;
    const result = await mutate<WorktreeRevalidation>((state) => {
      const { stored, currentBinding } = assertFreshObservation(state);
      if (!candidate || (!same && !options.acceptRebuild) || !canConfirmEvidence) {
        const next = worktreeWorkspaceRecordSchema.parse({
          ...stored,
          lifecycle: preserveLifecycle(stored, "active"),
          verification: "needsVerification",
        });
        const nextState = worktreeCatalogFileSchema.parse({
          ...state,
          workspaces: state.workspaces.map((item) => (item.id === workspaceId ? next : item)),
        });
        return {
          state: nextState,
          result: { status: "needsVerification", binding: currentBinding, workspace: next },
        };
      }
      const next = worktreeWorkspaceRecordSchema.parse({
        ...stored,
        isMainWorktree: candidate.isMainWorktree,
        head: candidate.head,
        lifecycle: preserveLifecycle(stored, "active"),
        verification: "verified",
        worktreeGeneration: same ? stored.worktreeGeneration : idFactory(),
        filesystemEvidence: candidate.filesystemEvidence,
      });
      const bindingChanged =
        currentBinding.gitCommonDir !== discovery.repositoryCommonDir ||
        !sameEvidenceRecord(currentBinding.commonDirEvidence, discovery.commonDirEvidence);
      const nextBinding = repositoryBindingRecordSchema.parse({
        ...currentBinding,
        gitCommonDir: discovery.repositoryCommonDir,
        commonDirEvidence: discovery.commonDirEvidence,
      });
      const nextState = worktreeCatalogFileSchema.parse({
        ...state,
        bindings: state.bindings.map((item) =>
          item.id === currentBinding.id ? nextBinding : item,
        ),
        workspaces: state.workspaces.map((item) =>
          item.id === workspaceId
            ? next
            : bindingChanged && item.repositoryBindingId === currentBinding.id
              ? { ...item, verification: "needsVerification" as const }
              : item,
        ),
      });
      return {
        state: nextState,
        result: { status: "verified", binding: nextBinding, workspace: next },
      };
    });
    if (result.status === "verified" && result.workspace.lifecycle !== "removed") {
      await admission?.register(result.workspace);
    }
    return result;
  }

  const removal = createWorkspaceRemoval({
    ...dependencies,
    admission,
    discover,
    mutate,
    read,
  });

  async function updateWorkspace(request: Parameters<IWorktreeService["updateWorkspace"]>[0]) {
    const current = (await read()).workspaces.find((item) => item.id === request.workspaceId);
    if (!current) throw new Error(`unknown-workspace:${request.workspaceId}`);
    if (request.operation === "rename" || !admission) {
      return workspaceMutations.updateWorkspace(request);
    }
    return admission.withFenceLock(current, async () => {
      const latest = (await read()).workspaces.find((item) => item.id === request.workspaceId);
      if (!latest || latest.worktreeGeneration !== current.worktreeGeneration) {
        throw new Error("stale-worktree-generation");
      }
      if (request.operation === "unarchive" && latest.lifecycle !== "archived") {
        throw new Error("workspace-not-archived");
      }
      // 归档只切准入元数据，运行事实仍由各自 owner 维护；同一锁避免 archive/send 交错。
      await admission.setLifecycleLocked(
        latest,
        latest.lifecycle === "archived" ? "archived" : "active",
      );
      const updated = await workspaceMutations.updateWorkspace(request);
      await admission.setLifecycleLocked(
        updated,
        request.operation === "archive" ? "archived" : "active",
      );
      return updated;
    });
  }

  async function createWorkspace(request: Parameters<IWorktreeService["createWorkspace"]>[0]) {
    const result = await workspaceMutations.createWorkspace(request);
    if (result.status !== "unregistered") await admission?.register(result.workspace);
    return result;
  }

  return {
    getAvailability,
    read,
    discover,
    adopt,
    adoptBareRepository,
    createWorkspace,
    updateWorkspace,
    ...removal,
    revalidate,
  };
}
