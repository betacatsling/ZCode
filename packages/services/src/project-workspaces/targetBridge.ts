import { randomUUID } from "node:crypto";
import type {
  RepositoryBinding,
  UnadoptedWorktreeCandidate,
  WorktreeWorkspace,
} from "@zcode/shared/project-workspaces";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import type {
  ProjectCatalogTargetPort,
  WorkspaceAdmissionPort,
  IProjectCatalogService,
} from "./serviceContract.js";
import { TargetWorktreeService } from "./worktreeService.js";
import type { TargetWorkspaceRecord } from "./worktreeReconciler.js";

/** Caller obtains remote identities via the existing shared remote identity builder, never by formatting here. */
export type TrustedWorkspaceIdentity = (targetId: string, canonicalPath: string) => string;

function head(record: { branch: string | null; head: string | null }): WorktreeWorkspace["head"] {
  if (record.branch)
    return {
      kind: "branch",
      ref: record.branch,
      oid: record.head && /^0+$/.test(record.head) ? null : record.head,
    };
  if (record.head) return { kind: "detached", oid: record.head };
  throw new Error("Unknown Git HEAD; cannot publish workspace identity");
}

/** Target-local bridge; only catalog owns titles/ordering, only target owns Git facts and admission. */
export class ProjectCatalogTargetBridge implements ProjectCatalogTargetPort {
  constructor(
    readonly target: TargetWorktreeService,
    readonly targetId: string,
    private readonly identity: TrustedWorkspaceIdentity,
  ) {}

  async inspectRepository(input: { targetId: string; path: string }) {
    if (input.targetId !== this.targetId) throw new Error("Wrong execution target");
    const facts = await this.target.inspectRepository(input.path);
    return { executionTargetId: this.targetId, gitCommonDir: facts.discovery.gitCommonDir };
  }
  async sameRepository(binding: RepositoryBinding, path: string) {
    if (binding.executionTargetId !== this.targetId) return false;
    return this.target.matchesBinding(binding.id, path);
  }
  async registerBinding(binding: RepositoryBinding, path: string) {
    if (binding.executionTargetId !== this.targetId) throw new Error("Wrong execution target");
    const registered = await this.target.registerBinding({
      receipt: { binding, requestKey: JSON.stringify([binding, path]) },
      id: binding.id,
      projectId: binding.projectId,
      executionTargetId: this.targetId,
      repositoryPath: path,
    });
    const facts = await this.target.inspectRepository(path);
    if (
      facts.discovery.gitCommonDir !== binding.gitCommonDir ||
      registered.repositoryPath !== (facts.discovery.worktreeRoot ?? registered.repositoryPath)
    )
      throw new Error("Repository changed during registration");
  }
  lookupBinding(id: string) {
    return this.target.lookupBinding(id);
  }
  async lookupWorkspace(id: string): Promise<WorktreeWorkspace | undefined> {
    const proof = await this.target.lookupWorkspace(id);
    if (!proof) return undefined;
    const binding = await this.target.lookupBinding(proof.record.bindingId);
    if (!binding || !proof.receipt.presentation)
      throw new Error("Target workspace receipt lacks original binding/presentation");
    return this.dto(
      binding,
      proof.record,
      proof.receipt.presentation.title,
      proof.receipt.presentation.sortOrder,
      proof.receipt.presentation.origin,
    );
  }
  setArchivePolicy(kind: "binding" | "workspace", id: string, archived: boolean) {
    return this.target.setArchivePolicy(kind, id, archived);
  }
  previewRemoval(id: string, generation: string) {
    return this.target.previewRemoval(id, generation);
  }
  private checkedBinding(binding: RepositoryBinding) {
    const record = this.target.bindings().find((entry) => entry.id === binding.id);
    if (
      !record ||
      record.executionTargetId !== this.targetId ||
      record.projectId !== binding.projectId ||
      binding.executionTargetId !== this.targetId ||
      record.repositoryPath.length === 0
    )
      throw new Error("Unknown binding at target");
    return record;
  }
  private async dto(
    binding: RepositoryBinding,
    record: TargetWorkspaceRecord,
    title: string,
    sortOrder: number,
    origin: WorktreeWorkspace["origin"],
  ): Promise<WorktreeWorkspace> {
    if (
      record.bindingId !== this.checkedBinding(binding).id ||
      !["active", "removed"].includes(record.lifecycle)
    )
      throw new Error("Invalid target record");
    const identity = this.identity(this.targetId, record.path);
    if (!identity?.trim()) throw new Error("No trusted target identity");
    return {
      schemaVersion: 1,
      id: record.id,
      projectId: binding.projectId,
      repositoryBindingId: binding.id,
      title,
      sortOrder,
      hidden: false,
      workspaceIdentity: identity,
      worktreePath: record.path,
      worktreeGeneration: record.generation,
      isMainWorktree: record.kind === "main",
      head: head(record),
      origin,
      lifecycle: record.lifecycle as "active" | "removed",
    };
  }
  async discover(binding: RepositoryBinding): Promise<readonly UnadoptedWorktreeCandidate[]> {
    this.checkedBinding(binding);
    const candidates = await this.target.discover(binding.id);
    return candidates
      .filter(
        (candidate) =>
          candidate.kind !== "bare" &&
          candidate.prunable === null &&
          candidate.adminIdentity !== null,
      )
      .map((candidate) => ({
        repositoryBindingId: binding.id,
        worktreePath: candidate.path,
        // Discovery does not register an instance or promise stable generations.
        worktreeGeneration: randomUUID(),
        workspaceIdentity: this.identity(this.targetId, candidate.path),
        isMainWorktree: candidate.kind === "main",
        head: head(candidate),
      }));
  }
  async adopt(input: {
    binding: RepositoryBinding;
    workspaceId: string;
    title: string;
    sortOrder: number;
    worktreePath: string;
  }) {
    this.checkedBinding(input.binding);
    const record = await this.target.adopt({
      bindingId: input.binding.id,
      workspaceId: input.workspaceId,
      worktreePath: input.worktreePath,
      receipt: {
        title: input.title,
        sortOrder: input.sortOrder,
        requestKey: JSON.stringify([
          input.binding.id,
          input.workspaceId,
          input.title,
          input.sortOrder,
          input.worktreePath,
        ]),
      },
    });
    return this.dto(input.binding, record, input.title, input.sortOrder, "adopted");
  }
  async create(input: {
    binding: RepositoryBinding;
    workspaceId: string;
    title: string;
    sortOrder: number;
    worktreePath: string;
    baseRef: string;
    branch: string;
  }) {
    this.checkedBinding(input.binding);
    const record = await this.target.create({
      bindingId: input.binding.id,
      workspaceId: input.workspaceId,
      worktreePath: input.worktreePath,
      branch: input.branch,
      baseRef: input.baseRef,
      mode: "new",
      receipt: {
        title: input.title,
        sortOrder: input.sortOrder,
        requestKey: JSON.stringify([
          input.binding.id,
          input.workspaceId,
          input.title,
          input.sortOrder,
          input.worktreePath,
          input.branch,
          input.baseRef,
        ]),
      },
    });
    return this.dto(input.binding, record, input.title, input.sortOrder, "created");
  }
  async remove(input: {
    workspaceId: string;
    expectedGeneration: string;
    confirmation: true;
    workspace: WorktreeWorkspace;
  }) {
    const old = input.workspace;
    const registered = this.target.history(input.workspaceId);
    const binding = this.target.bindings().find((entry) => entry.id === old.repositoryBindingId);
    if (
      !registered ||
      !binding ||
      binding.projectId !== old.projectId ||
      registered.bindingId !== binding.id ||
      registered.generation !== input.expectedGeneration ||
      registered.generation !== old.worktreeGeneration ||
      registered.path !== old.worktreePath ||
      this.identity(this.targetId, registered.path) !== old.workspaceIdentity ||
      old.id !== input.workspaceId
    )
      throw new Error("Target removal identity mismatch");
    const record = await this.target.remove(
      input.workspaceId,
      input.expectedGeneration,
      input.confirmation,
      {
        title: old.title,
        sortOrder: old.sortOrder,
        origin: old.origin,
        requestKey: JSON.stringify([
          old.id,
          old.worktreeGeneration,
          old.workspaceIdentity,
          old.worktreePath,
        ]),
      },
    );
    if (record.lifecycle !== "removed") throw new Error("Target removal did not complete");
    return { ...old, lifecycle: "removed" as const };
  }
}

/** Host-local callback never crosses RPC. Catalog reads persisted ownership; target gates real cwd/effects. */
export class CatalogWorkspaceAdmission implements WorkspaceAdmissionPort {
  constructor(
    private readonly catalog: Pick<IProjectCatalogService, "sidebarSnapshot">,
    private readonly target: TargetWorktreeService,
    private readonly targetId: string,
  ) {}
  private async check(spec: SessionSpecV2) {
    const snapshot = await this.catalog.sidebarSnapshot();
    const project = snapshot.projects.find((row) => row.id === spec.projectId);
    const workspace = snapshot.workspaces.find((row) => row.id === spec.workspaceId);
    const binding = snapshot.bindings.find((row) => row.id === workspace?.repositoryBindingId);
    if (
      !project ||
      !binding ||
      !workspace ||
      project.archived ||
      workspace.archived ||
      project.id !== binding.projectId ||
      project.id !== workspace.projectId ||
      binding.executionTargetId !== this.targetId ||
      spec.execution.targetId !== this.targetId ||
      workspace.lifecycle !== "active" ||
      workspace.workspaceIdentity !== spec.execution.workspaceIdentity ||
      workspace.worktreeGeneration !== spec.execution.worktreeGeneration ||
      workspace.worktreePath !== spec.execution.worktreePath
    )
      throw new Error("Persisted workspace scope not admitted");
    const record = this.target.history(workspace.id);
    const targetBinding = this.target.bindings().find((row) => row.id === binding.id);
    if (
      !targetBinding ||
      targetBinding.projectId !== project.id ||
      !record ||
      record.bindingId !== binding.id ||
      record.generation !== workspace.worktreeGeneration ||
      record.path !== workspace.worktreePath
    )
      throw new Error("Target workspace scope not admitted");
  }
  async verify(spec: SessionSpecV2): Promise<{ canonicalCwd: string }> {
    await this.check(spec);
    return {
      canonicalCwd: await this.target.verify(
        spec.workspaceId,
        spec.execution.worktreeGeneration,
        spec.execution.cwdRelativeToWorktree,
      ),
    };
  }
  async withAdmission<T>(
    spec: SessionSpecV2,
    action: (canonicalCwd: string) => Promise<T>,
  ): Promise<T> {
    await this.check(spec);
    return this.target.withAdmission(
      spec.workspaceId,
      spec.execution.worktreeGeneration,
      action,
      spec.execution.cwdRelativeToWorktree,
    );
  }
}
