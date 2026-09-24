import { z } from "zod";
import { Emitter } from "@zcode/rpc";
import {
  projectSchema,
  repositoryBindingSchema,
  worktreeWorkspaceSchema,
  worktreeOperationSchema,
  unadoptedWorktreeCandidateSchema,
  type Project,
  type RepositoryBinding,
  type WorktreeWorkspace,
  type WorktreeOperation,
  type UnadoptedWorktreeCandidate,
} from "@zcode/shared/project-workspaces";
import type { IProjectCatalogService, ProjectCatalogTargetPort } from "./serviceContract.js";
import { sidebarIndex, type CatalogSessionIndex } from "./sidebarIndexService.js";
import { ProfileFileOwner } from "./profilePersistence.js";

const catalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  projects: z.array(projectSchema),
  bindings: z.array(repositoryBindingSchema),
  workspaces: z.array(worktreeWorkspaceSchema),
});
type State = z.infer<typeof catalogSchema>;
const initial: State = {
  schemaVersion: 1,
  revision: 0,
  projects: [],
  bindings: [],
  workspaces: [],
};

/** One process-wide profile writer; all target facts enter only via the injected port. */
export class ProjectCatalog implements IProjectCatalogService {
  private state: State;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(revision: number) => void>();
  private readonly changes = new Emitter<number>();
  readonly onDidChange = this.changes.event;
  private currentRevision: number;
  private unsubscribeIndex?: () => void;
  private closing = false;

  private constructor(
    private readonly owner: ProfileFileOwner,
    private readonly target: ProjectCatalogTargetPort,
    private readonly index: CatalogSessionIndex,
    state: State,
  ) {
    this.state = state;
    this.currentRevision = state.revision;
    this.unsubscribeIndex = index.onChange?.(() => {
      if (!this.closing) this.emitChange();
    });
  }

  private emitChange(): void {
    const revision = ++this.currentRevision;
    this.changes.fire(revision);
    for (const listener of this.listeners) {
      try {
        listener(revision);
      } catch {
        /* A subscriber cannot invalidate a committed write. */
      }
    }
  }

  static async open(
    path: string,
    target: ProjectCatalogTargetPort,
    index: CatalogSessionIndex,
  ): Promise<ProjectCatalog> {
    const owner = await ProfileFileOwner.open(path);
    try {
      const raw = await owner.read();
      const state = raw === undefined ? initial : catalogSchema.parse(raw);
      // 中文：未知版本绝不可当空目录重建，否则旧进程会覆盖新版本的数据。
      sidebarIndex({ ...state, sessions: [], freshness: new Map() });
      return new ProjectCatalog(owner, target, index, state);
    } catch (error) {
      await owner.close();
      throw error;
    }
  }

  get revision(): number {
    return this.currentRevision;
  }
  async getRevision(): Promise<number> {
    await this.queue;
    return this.currentRevision;
  }
  onChange(listener: (revision: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  async close(): Promise<void> {
    this.closing = true;
    this.unsubscribeIndex?.();
    await this.queue;
    await this.owner.close();
    this.changes.dispose();
  }
  async project(id: string): Promise<Project | undefined> {
    return this.state.projects.find((p) => p.id === id);
  }
  async binding(id: string): Promise<RepositoryBinding | undefined> {
    return this.state.bindings.find((b) => b.id === id);
  }
  async workspace(id: string): Promise<WorktreeWorkspace | undefined> {
    return this.state.workspaces.find((w) => w.id === id);
  }
  async sidebarSnapshot() {
    await this.queue;
    const state = this.state;
    const [sessions, freshness] = await Promise.all([
      this.index.allSessions(),
      Promise.all(
        state.workspaces.map(async (w) => [w.id, await this.index.workspaceFreshness(w)] as const),
      ),
    ]);
    return sidebarIndex({
      ...state,
      sessions,
      freshness: new Map(freshness),
      revision: this.currentRevision,
    });
  }
  private mutate<T>(
    action: (state: State) => Promise<{
      state: State;
      result: T;
      afterCommit?: () => Promise<void>;
    }>,
  ): Promise<T> {
    if (this.closing) return Promise.reject(new Error("catalog-closed"));
    const job = this.queue.then(async () => {
      const { state, result, afterCommit } = await action(this.state);
      const next = catalogSchema.parse({ ...state, revision: this.currentRevision + 1 });
      sidebarIndex({ ...next, sessions: [], freshness: new Map() });
      await this.owner.write(next);
      this.state = next;
      this.currentRevision = Math.max(this.currentRevision, next.revision - 1);
      this.emitChange();
      await afterCommit?.();
      return result;
    });
    this.queue = job.catch(() => undefined);
    return job;
  }
  importProject(input: {
    id: string;
    name: string;
    targetId: string;
    repositoryPath: string;
    bindingId: string;
  }): Promise<Project> {
    return this.mutate(async (state) => {
      if (
        state.projects.some((p) => p.id === input.id) ||
        state.bindings.some((b) => b.id === input.bindingId)
      )
        throw new Error("duplicate-id");
      const facts = await this.target.inspectRepository({
        targetId: input.targetId,
        path: input.repositoryPath,
      });
      if (facts.executionTargetId !== input.targetId) throw new Error("invalid-target");
      for (const binding of state.bindings) {
        if (
          binding.executionTargetId === facts.executionTargetId &&
          (await this.target.sameRepository(binding, input.repositoryPath))
        )
          throw new Error("repository-already-imported");
      }
      const project = projectSchema.parse({
        schemaVersion: 1,
        id: input.id,
        name: input.name,
        sortOrder: state.projects.length,
      });
      const binding = repositoryBindingSchema.parse({
        schemaVersion: 1,
        id: input.bindingId,
        projectId: project.id,
        ...facts,
      });
      await this.target.registerBinding(binding, input.repositoryPath);
      return {
        state: {
          ...state,
          projects: [...state.projects, project],
          bindings: [...state.bindings, binding],
        },
        result: project,
      };
    });
  }
  updateProject(
    id: string,
    update: {
      name?: string;
      iconAssetId?: string | null;
      pinned?: boolean;
      hidden?: boolean;
      archived?: boolean;
      defaultWorkspaceId?: string | null;
      sortOrder?: number;
    },
  ): Promise<Project> {
    return this.mutate(async (state) => {
      const existing = state.projects.find((p) => p.id === id);
      if (!existing) throw new Error("unknown-project");
      const project = projectSchema.parse({
        ...existing,
        ...update,
        iconAssetId:
          update.iconAssetId === null ? undefined : (update.iconAssetId ?? existing.iconAssetId),
        defaultWorkspaceId:
          update.defaultWorkspaceId === null
            ? undefined
            : (update.defaultWorkspaceId ?? existing.defaultWorkspaceId),
      });
      if (
        project.defaultWorkspaceId &&
        !state.workspaces.some((w) => w.id === project.defaultWorkspaceId && w.projectId === id)
      )
        throw new Error("invalid-ownership");
      if (update.archived === true) {
        // 中文：目标先拒绝新 admission；失败时不能将本地目录谎报为已归档。
        for (const binding of state.bindings.filter((b) => b.projectId === id))
          await this.target.setArchivePolicy("binding", binding.id, true);
      }
      return {
        state: { ...state, projects: state.projects.map((p) => (p.id === id ? project : p)) },
        result: project,
        afterCommit:
          update.archived === false
            ? async () => {
                for (const binding of state.bindings.filter((b) => b.projectId === id))
                  await this.target.setArchivePolicy("binding", binding.id, false);
              }
            : undefined,
      };
    });
  }
  updateWorkspace(
    id: string,
    update: { title?: string; hidden?: boolean; archived?: boolean; sortOrder?: number },
  ): Promise<WorktreeWorkspace> {
    return this.mutate(async (state) => {
      const old = state.workspaces.find((w) => w.id === id);
      if (!old) throw new Error("unknown-workspace");
      // 中文：归档不修改 Git 生命周期，但必须先让目标 admission 持久拒绝新命令。
      const workspace = worktreeWorkspaceSchema.parse({ ...old, ...update });
      if (update.archived === true) await this.target.setArchivePolicy("workspace", id, true);
      return {
        state: { ...state, workspaces: state.workspaces.map((w) => (w.id === id ? workspace : w)) },
        result: workspace,
        afterCommit:
          update.archived === false
            ? () => this.target.setArchivePolicy("workspace", id, false)
            : undefined,
      };
    });
  }
  async discover(bindingId: string) {
    const binding = await this.binding(bindingId);
    if (!binding) throw new Error("unknown-binding");
    const candidates = await this.target.discover(binding);
    return candidates.map((candidate) => {
      const parsed = unadoptedWorktreeCandidateSchema.parse(candidate);
      if (parsed.repositoryBindingId !== bindingId) throw new Error("invalid-ownership");
      return parsed;
    });
  }
  private addWorkspace(
    input: {
      bindingId: string;
      workspaceId: string;
      title: string;
      worktreePath: string;
      baseRef?: string;
      branch?: string;
    },
    kind: "adopt" | "create",
  ): Promise<WorktreeWorkspace> {
    return this.mutate(async (state) => {
      const binding = state.bindings.find((b) => b.id === input.bindingId);
      if (!binding) throw new Error("unknown-binding");
      if (state.projects.find((p) => p.id === binding.projectId)?.archived)
        throw new Error("project-archived");
      if (state.workspaces.some((w) => w.id === input.workspaceId)) throw new Error("duplicate-id");
      const args = {
        binding,
        workspaceId: input.workspaceId,
        title: input.title,
        sortOrder: state.workspaces.length,
        worktreePath: input.worktreePath,
      };
      const facts =
        kind === "adopt"
          ? await this.target.adopt(args)
          : await this.target.create({ ...args, baseRef: input.baseRef!, branch: input.branch! });
      const workspace = worktreeWorkspaceSchema.parse(facts);
      if (
        workspace.id !== input.workspaceId ||
        workspace.repositoryBindingId !== binding.id ||
        workspace.projectId !== binding.projectId ||
        workspace.origin !== (kind === "adopt" ? "adopted" : "created") ||
        workspace.lifecycle !== "active" ||
        // 中文：目标端返回规范路径；macOS /var 与 /private/var 等别名不能用输入字符串判等。
        state.workspaces.some(
          (w) =>
            w.repositoryBindingId === binding.id &&
            w.workspaceIdentity === workspace.workspaceIdentity &&
            w.lifecycle !== "removed",
        )
      )
        throw new Error("invalid-target-workspace");
      return {
        state: { ...state, workspaces: [...state.workspaces, workspace] },
        result: workspace,
      };
    });
  }
  adopt(input: { bindingId: string; workspaceId: string; title: string; worktreePath: string }) {
    return this.addWorkspace(input, "adopt");
  }
  create(input: {
    bindingId: string;
    workspaceId: string;
    title: string;
    worktreePath: string;
    baseRef: string;
    branch: string;
  }) {
    return this.addWorkspace(input, "create");
  }
  async previewRemoval(workspaceId: string, expectedGeneration: string) {
    const workspace = this.state.workspaces.find((w) => w.id === workspaceId);
    if (!workspace || workspace.worktreeGeneration !== expectedGeneration)
      throw new Error("stale-workspace");
    return this.target.previewRemoval(workspaceId, expectedGeneration);
  }
  remove(input: {
    workspaceId: string;
    expectedGeneration: string;
    confirmation: true;
  }): Promise<WorktreeWorkspace> {
    return this.mutate(async (state) => {
      const old = state.workspaces.find((w) => w.id === input.workspaceId);
      if (
        !old ||
        old.worktreeGeneration !== input.expectedGeneration ||
        input.confirmation !== true
      )
        throw new Error("stale-workspace-or-confirmation");
      const facts = worktreeWorkspaceSchema.parse(
        await this.target.remove({ ...input, workspace: old }),
      );
      if (
        facts.id !== old.id ||
        facts.projectId !== old.projectId ||
        facts.repositoryBindingId !== old.repositoryBindingId ||
        facts.workspaceIdentity !== old.workspaceIdentity ||
        facts.worktreeGeneration !== old.worktreeGeneration ||
        facts.lifecycle !== "removed"
      )
        throw new Error("invalid-target-workspace");
      return {
        state: { ...state, workspaces: state.workspaces.map((w) => (w.id === old.id ? facts : w)) },
        result: facts,
      };
    });
  }
  apply(
    operation: WorktreeOperation,
  ): Promise<WorktreeWorkspace | readonly UnadoptedWorktreeCandidate[]> {
    const op = worktreeOperationSchema.parse(operation);
    if (op.kind === "discover") return this.discover(op.repositoryBindingId);
    if (op.kind === "adopt")
      return this.adopt({
        bindingId: op.repositoryBindingId,
        workspaceId: op.workspaceId,
        title: op.title,
        worktreePath: op.worktreePath,
      });
    if (op.kind === "create")
      return this.create({
        bindingId: op.repositoryBindingId,
        workspaceId: op.workspaceId,
        title: op.title,
        worktreePath: op.worktreePath,
        baseRef: op.baseRef,
        branch: op.branch,
      });
    return this.remove(op);
  }
}
