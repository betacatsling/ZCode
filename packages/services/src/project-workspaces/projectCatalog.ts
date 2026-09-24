/* eslint-disable max-lines -- Profile owner serializes catalog mutations and durable recovery under one lease. */
import { z } from "zod";
import { readFile } from "node:fs/promises";
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

const pendingSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("import"),
    project: projectSchema,
    binding: repositoryBindingSchema,
    repositoryPath: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("adopt"),
    bindingId: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string(),
    worktreePath: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("create"),
    bindingId: z.string().min(1),
    workspaceId: z.string().min(1),
    title: z.string(),
    worktreePath: z.string().min(1),
    baseRef: z.string(),
    branch: z.string(),
  }),
  z.strictObject({ kind: z.literal("remove"), workspace: worktreeWorkspaceSchema }),
  z.strictObject({ kind: z.literal("archiveProject"), project: projectSchema }),
  z.strictObject({ kind: z.literal("archiveWorkspace"), workspace: worktreeWorkspaceSchema }),
]);
type Pending = z.infer<typeof pendingSchema>;

export const nativeCatalogReferenceSchema = z.strictObject({
  commandId: z.string().min(1),
  originalSessionId: z.string().min(1),
  targetId: z.string().min(1),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  repositoryBindingId: z.string().min(1),
  worktreeGeneration: z.string().min(1),
  workspaceIdentity: z.string().min(1),
  workspacePath: z.string().min(1),
});
export type NativeCatalogReference = z.infer<typeof nativeCatalogReferenceSchema>;

const catalogSchema = z.strictObject({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  projects: z.array(projectSchema),
  bindings: z.array(repositoryBindingSchema),
  workspaces: z.array(worktreeWorkspaceSchema),
  pending: pendingSchema.optional(),
  nativeReferences: z.array(nativeCatalogReferenceSchema).optional(),
});
type State = z.infer<typeof catalogSchema>;
/** Read-only Catalog projection for the Core directory; no CLI startup or migration. */
export async function readNativeCatalogReferences(
  path: string,
): Promise<readonly NativeCatalogReference[]> {
  try {
    return catalogSchema.parse(JSON.parse(await readFile(path, "utf8"))).nativeReferences ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

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
    options: { recoverStaleOwner?: boolean } = {},
  ): Promise<ProjectCatalog> {
    const owner = await ProfileFileOwner.open(path, options.recoverStaleOwner);
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
  /** Local Core-only commit after the CLI receipt and new mapping are certified. Not an RPC method. */
  async commitNativeReference(value: NativeCatalogReference): Promise<void> {
    const reference = nativeCatalogReferenceSchema.parse(value);
    // 中文：故障注入只发生在完成的 CLI 映射之后、Catalog 提交之前；检验只读修复。
    if (process.env.ZCODE_CORE_NATIVE_CATALOG_FAULT_TEST_ONLY === reference.commandId)
      throw new Error("native-catalog-commit-fault-test-only");
    await this.mutate(async (state) => {
      const workspace = state.workspaces.find((row) => row.id === reference.workspaceId);
      const binding = state.bindings.find((row) => row.id === reference.repositoryBindingId);
      // 中文：补写已完成的 Catalog 引用也不能把复用路径/旧代绑定变成当前可执行 owner。
      if (
        !workspace ||
        !binding ||
        workspace.lifecycle !== "active" ||
        workspace.archived ||
        workspace.projectId !== reference.projectId ||
        workspace.repositoryBindingId !== reference.repositoryBindingId ||
        workspace.worktreeGeneration !== reference.worktreeGeneration ||
        workspace.workspaceIdentity !== reference.workspaceIdentity ||
        workspace.worktreePath !== reference.workspacePath ||
        binding.executionTargetId !== reference.targetId ||
        binding.projectId !== reference.projectId
      )
        throw new Error("native-catalog-reference-stale-scope");
      const prior = state.nativeReferences?.find((row) => row.commandId === reference.commandId);
      if (prior) {
        if (JSON.stringify(prior) !== JSON.stringify(reference))
          throw new Error("native-catalog-reference-conflict");
        return { state, result: undefined, unchanged: true };
      }
      if (
        state.nativeReferences?.some((row) => row.originalSessionId === reference.originalSessionId)
      )
        throw new Error("native-catalog-reference-duplicate-id");
      return {
        state: { ...state, nativeReferences: [...(state.nativeReferences ?? []), reference] },
        result: undefined,
      };
    });
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
      unchanged?: boolean;
    }>,
  ): Promise<T> {
    if (this.closing) return Promise.reject(new Error("catalog-closed"));
    const job = this.queue.then(async () => {
      if (this.state.pending) throw new Error("catalog-pending-target-operation");
      const { state, result, afterCommit, unchanged } = await action(this.state);
      if (unchanged) return result;
      const next = catalogSchema.parse({
        ...state,
        pending: undefined,
        revision: this.currentRevision + 1,
      });
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
  private async beginIntent(pending: Pending): Promise<void> {
    // 中文：先持久化意图再请求目标；未知执行结果只能查目标的 ID，不能重放 Git。
    const state = catalogSchema.parse({ ...this.state, pending });
    await this.owner.write(state);
    this.state = state;
  }

  async reconcilePending(): Promise<void> {
    const job = this.queue.then(async () => {
      const pending = this.state.pending;
      if (!pending) return;
      // 中文：rename 已成功但目录 fsync 报错时磁盘可能已有完整提交；重读以免重复追加。
      const raw = await this.owner.read();
      const persisted = catalogSchema.parse(raw);
      if (!persisted.pending) {
        if (persisted.revision <= this.state.revision) throw new Error("catalog-intent-lost");
        this.state = persisted;
        this.currentRevision = Math.max(this.currentRevision, persisted.revision - 1);
        this.emitChange();
        return;
      }
      if (JSON.stringify(persisted.pending) !== JSON.stringify(pending))
        throw new Error("catalog-intent-mismatch");
      let next: State;
      if (pending.kind === "archiveProject") {
        const old = this.state.projects.find((p) => p.id === pending.project.id);
        if (!old || !pending.project.archived) throw new Error("catalog-archive-intent-mismatch");
        for (const binding of this.state.bindings.filter((b) => b.projectId === old.id))
          await this.target.setArchivePolicy("binding", binding.id, true);
        next = {
          ...this.state,
          projects: this.state.projects.map((p) => (p.id === old.id ? pending.project : p)),
        };
      } else if (pending.kind === "archiveWorkspace") {
        const old = this.state.workspaces.find((w) => w.id === pending.workspace.id);
        if (
          !old ||
          !pending.workspace.archived ||
          old.worktreeGeneration !== pending.workspace.worktreeGeneration ||
          old.workspaceIdentity !== pending.workspace.workspaceIdentity
        )
          throw new Error("catalog-archive-intent-mismatch");
        await this.target.setArchivePolicy("workspace", old.id, true);
        next = {
          ...this.state,
          workspaces: this.state.workspaces.map((w) => (w.id === old.id ? pending.workspace : w)),
        };
      } else if (pending.kind === "import") {
        const binding = await this.target.lookupBinding?.(pending.binding.id);
        if (!binding) throw new Error("catalog-target-result-unknown");
        if (
          JSON.stringify(binding) !== JSON.stringify(pending.binding) ||
          this.state.bindings.some((b) => b.id === binding.id) ||
          this.state.projects.some((p) => p.id === pending.project.id)
        )
          throw new Error("catalog-target-binding-mismatch");
        next = {
          ...this.state,
          projects: [...this.state.projects, pending.project],
          bindings: [...this.state.bindings, pending.binding],
        };
      } else {
        const expected = pending.kind === "remove" ? pending.workspace : undefined;
        const workspaceId = pending.kind === "remove" ? pending.workspace.id : pending.workspaceId;
        const bindingId =
          pending.kind === "remove" ? pending.workspace.repositoryBindingId : pending.bindingId;
        const workspace = await this.target.lookupWorkspace?.(workspaceId);
        if (!workspace) throw new Error("catalog-target-result-unknown");
        const binding = this.state.bindings.find((b) => b.id === bindingId);
        if (
          !binding ||
          workspace.id !== workspaceId ||
          workspace.repositoryBindingId !== binding.id ||
          workspace.projectId !== binding.projectId ||
          workspace.lifecycle !== (pending.kind === "remove" ? "removed" : "active") ||
          (expected &&
            (workspace.worktreeGeneration !== expected.worktreeGeneration ||
              workspace.workspaceIdentity !== expected.workspaceIdentity ||
              workspace.worktreePath !== expected.worktreePath)) ||
          (pending.kind !== "remove" &&
            (workspace.title !== pending.title ||
              workspace.origin !== (pending.kind === "adopt" ? "adopted" : "created") ||
              this.state.workspaces.some(
                (old) =>
                  old.id === workspace.id ||
                  (old.repositoryBindingId === binding.id &&
                    old.lifecycle !== "removed" &&
                    old.workspaceIdentity === workspace.workspaceIdentity),
              )))
        )
          throw new Error("catalog-target-workspace-mismatch");
        next =
          pending.kind === "remove"
            ? {
                ...this.state,
                workspaces: this.state.workspaces.map((w) =>
                  w.id === expected!.id ? workspace : w,
                ),
              }
            : { ...this.state, workspaces: [...this.state.workspaces, workspace] };
      }
      const committed = catalogSchema.parse({
        ...next,
        pending: undefined,
        revision: this.currentRevision + 1,
      });
      sidebarIndex({ ...committed, sessions: [], freshness: new Map() });
      await this.owner.write(committed);
      this.state = committed;
      this.currentRevision = Math.max(this.currentRevision, committed.revision - 1);
      this.emitChange();
    });
    this.queue = job.catch(() => undefined);
    return job;
  }

  async reconcileArchivePolicies(): Promise<void> {
    const job = this.queue.then(async () => {
      if (this.state.pending) throw new Error("catalog-pending-target-operation");
      // 中文：先写完全部拒绝策略，再恢复允许，防止部分归档期间开放 admission。
      for (const binding of this.state.bindings) {
        const project = this.state.projects.find((p) => p.id === binding.projectId);
        if (!project) throw new Error("invalid-catalog-binding");
        if (project.archived) await this.target.setArchivePolicy("binding", binding.id, true);
      }
      for (const workspace of this.state.workspaces) {
        if (workspace.archived) await this.target.setArchivePolicy("workspace", workspace.id, true);
      }
      for (const binding of this.state.bindings) {
        if (!this.state.projects.find((p) => p.id === binding.projectId)?.archived)
          await this.target.setArchivePolicy("binding", binding.id, false);
      }
      for (const workspace of this.state.workspaces) {
        if (!workspace.archived)
          await this.target.setArchivePolicy("workspace", workspace.id, false);
      }
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
      await this.beginIntent({
        kind: "import",
        project,
        binding,
        repositoryPath: input.repositoryPath,
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
        await this.beginIntent({ kind: "archiveProject", project });
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
      if (update.archived === true) {
        await this.beginIntent({ kind: "archiveWorkspace", workspace });
        await this.target.setArchivePolicy("workspace", id, true);
      }
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
      await this.beginIntent({
        kind,
        bindingId: input.bindingId,
        workspaceId: input.workspaceId,
        title: input.title,
        worktreePath: input.worktreePath,
        ...(kind === "create" ? { baseRef: input.baseRef!, branch: input.branch! } : {}),
      } as Pending);
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
      // 中文：已知不安全的预检不产生目标副作用，不能留下执行未知的持久意图。
      const preview = await this.target.previewRemoval(old.id, input.expectedGeneration);
      if (!preview.safe) throw new Error("unsafe-removal-preview");
      await this.beginIntent({ kind: "remove", workspace: old });
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
