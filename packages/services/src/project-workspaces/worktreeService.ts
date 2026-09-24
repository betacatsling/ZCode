/* eslint-disable max-lines -- Target registry keeps admission, archive policy and removal under one serialized authority gate. */
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import {
  createGitWorktree,
  preflightRemoveGitWorktree,
  removeGitWorktree,
  resolveGitWorktreeCwd,
  type GitRemovePreflight,
} from "./adapters/gitWorktreeBackend.js";
import {
  assertSameRepository,
  findCandidate,
  inspectRepository,
  sameFile,
  type FileIdentity,
  type RepositoryInspection,
} from "./repositoryBindingResolver.js";
import { TargetAuthorityStore, type TargetSnapshot } from "./targetAuthorityStore.js";
import { TargetInstanceMarker } from "./targetInstanceMarker.js";
import { reconcileWorkspace, type TargetWorkspaceRecord } from "./worktreeReconciler.js";

export interface TargetBindingRecord {
  id: string;
  projectId?: string;
  executionTargetId: string;
  repositoryPath: string;
  commonIdentity: FileIdentity;
  instanceMarker: string;
}
export interface TargetRuntimeActivity {
  running: number;
  waiting: number;
  tools: number;
  uncertain: number;
  offline: boolean;
}
export interface TargetWorktreeOptions {
  storageDirectory: string;
  executionTargetId: string;
  /** Explicit restart recovery only; refuses any live/unknown previous process. */
  recoverStaleOwner?: boolean;
  /** Must aggregate native AND external runtime activity; an absent/unknown owner is unsafe. */
  activity: (workspaceId: string) => Promise<TargetRuntimeActivity>;
}
export interface CreateTargetWorktreeRequest {
  bindingId: string;
  workspaceId: string;
  worktreePath: string;
  branch: string;
  mode: "new" | "existing";
  baseRef?: string;
}

export interface PendingTargetCreation {
  workspaceId: string;
  bindingId: string;
  /** Canonical parent plus requested basename, captured before Git mutation. */
  worktreePath: string;
  branch: string;
  mode: "new" | "existing";
  baseRef?: string;
}

export interface RemovalPreview {
  workspaceId: string;
  generation: string;
  git: GitRemovePreflight | null;
  activity: TargetRuntimeActivity | null;
  unknown: boolean;
  safe: boolean;
}

export class TargetWorktreeService {
  private serial: Promise<unknown> = Promise.resolve();
  private readonly frozen = new Set<string>();
  private readonly previews = new Set<string>();
  private closed = false;
  private readonly marker: TargetInstanceMarker;

  private constructor(
    private readonly options: TargetWorktreeOptions,
    private readonly store: TargetAuthorityStore,
  ) {
    this.marker = new TargetInstanceMarker(options.executionTargetId);
  }

  private get state(): TargetSnapshot {
    return this.store.state;
  }
  private save(next: TargetSnapshot): Promise<void> {
    return this.store.save(next);
  }

  static async open(options: TargetWorktreeOptions): Promise<TargetWorktreeService> {
    if (!options.executionTargetId.trim() || !options.activity)
      throw new Error("Target namespace and authoritative activity provider are required");
    return new TargetWorktreeService(
      options,
      await TargetAuthorityStore.open(
        options.storageDirectory,
        options.executionTargetId,
        options.recoverStaleOwner,
      ),
    );
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(async () => {
      if (this.closed) throw new Error("Target owner closed");
      await this.store.assertLease();
      return operation();
    });
    this.serial = result.catch(() => undefined);
    return result;
  }

  private binding(id: string): TargetBindingRecord {
    const found = this.state.bindings.find((entry) => entry.id === id);
    if (!found) throw new Error("Unknown target binding");
    return found;
  }
  private workspace(id: string): TargetWorkspaceRecord {
    const found = this.state.workspaces.find((entry) => entry.id === id);
    if (!found) throw new Error("Unknown target workspace");
    return found;
  }
  private async inspectBinding(
    binding: TargetBindingRecord,
    repositoryPath = binding.repositoryPath,
  ): Promise<RepositoryInspection> {
    const inspected = await inspectRepository(repositoryPath);
    assertSameRepository(inspected, binding.commonIdentity);
    if (
      !(await this.marker.matches(
        inspected.discovery.gitCommonDir,
        "binding",
        binding.instanceMarker,
      ))
    )
      throw new Error("Repository instance marker changed on this target");
    return inspected;
  }
  private async current(
    record: TargetWorkspaceRecord,
    expectedGeneration: string,
    markStale = true,
  ): Promise<TargetWorkspaceRecord> {
    if (record.generation !== expectedGeneration || record.lifecycle !== "active")
      throw new Error("Workspace generation is not admitted");
    const inspected = await this.inspectBinding(this.binding(record.bindingId));
    const match = inspected.candidates.find(
      (candidate) =>
        candidate.adminIdentity && sameFile(candidate.adminIdentity, record.adminIdentity),
    );
    if (
      !match ||
      !match.adminPath ||
      !(await this.marker.matches(match.adminPath, "workspace", record.instanceMarker)) ||
      match.path !== record.path ||
      match.kind !== record.kind
    ) {
      // Git 扫描成功但实例证据不符时冻结旧历史；只读预览与扫描失败不覆盖缓存事实。
      if (markStale)
        await this.save({
          ...this.state,
          workspaces: this.state.workspaces.map((item) =>
            item.id === record.id ? { ...item, lifecycle: "needsVerification" } : item,
          ),
        });
      throw new Error("Workspace instance or path requires reconciliation");
    }
    return record;
  }

  inspectRepository(pathOnTarget: string): Promise<RepositoryInspection> {
    return inspectRepository(pathOnTarget);
  }
  bindings(): readonly TargetBindingRecord[] {
    return this.state.bindings.map((item) => ({ ...item }));
  }
  records(): readonly TargetWorkspaceRecord[] {
    return this.state.workspaces.map((item) => ({ ...item }));
  }
  /** Incomplete Git effects require an explicit, evidence-checked recovery; not a retry. */
  pendingCreations(): readonly PendingTargetCreation[] {
    return (this.state.pendingCreations ?? []).map((item) => ({ ...item }));
  }
  /** Explicitly claims the verifiable Git candidate without running Git create again. */
  recoverCreation(workspaceId: string): Promise<TargetWorkspaceRecord> {
    return this.exclusive(async () => {
      throw new Error(`Creation recovery not yet implemented: ${workspaceId}`);
    });
  }
  history(workspaceId: string): TargetWorkspaceRecord | undefined {
    const record = this.state.workspaces.find((item) => item.id === workspaceId);
    return record ? { ...record, adminIdentity: { ...record.adminIdentity } } : undefined;
  }

  registerBinding(request: {
    id: string;
    projectId?: string;
    executionTargetId: string;
    repositoryPath: string;
  }): Promise<TargetBindingRecord> {
    return this.exclusive(async () => {
      if (
        !request.id ||
        request.executionTargetId !== this.options.executionTargetId ||
        this.state.bindings.some((item) => item.id === request.id)
      )
        throw new Error("Invalid/duplicate target binding");
      const inspected = await inspectRepository(request.repositoryPath);
      if (
        this.state.bindings.some((entry) =>
          sameFile(entry.commonIdentity, inspected.commonIdentity),
        )
      ) {
        throw new Error("Repository instance already registered on target");
      }
      const binding = {
        ...request,
        repositoryPath:
          inspected.discovery.worktreeRoot ?? (await realpath(request.repositoryPath)),
        commonIdentity: inspected.commonIdentity,
        instanceMarker: await this.marker.assign(inspected.discovery.gitCommonDir, "binding"),
      };
      await this.save({ ...this.state, bindings: [...this.state.bindings, binding] });
      return binding;
    });
  }

  private async adoptCandidate(
    bindingId: string,
    workspaceId: string,
    requestedPath: string,
  ): Promise<TargetWorkspaceRecord> {
    if (!workspaceId || this.state.workspaces.some((item) => item.id === workspaceId))
      throw new Error("Workspace ID already registered");
    if ((this.state.archivedBindings ?? []).includes(bindingId))
      throw new Error("Repository binding archived");
    const inspected = await this.inspectBinding(this.binding(bindingId));
    const candidate = findCandidate(inspected, await realpath(requestedPath));
    if (
      !candidate ||
      !candidate.adminIdentity ||
      !candidate.adminPath ||
      candidate.prunable !== null ||
      candidate.kind === "bare"
    )
      throw new Error("No verifiable runnable worktree at requested path");
    const adminIdentity = candidate.adminIdentity;
    if (
      this.state.workspaces.some(
        (item) =>
          item.lifecycle !== "removed" &&
          item.bindingId === bindingId &&
          sameFile(item.adminIdentity, adminIdentity),
      )
    )
      throw new Error("Worktree instance already registered");
    const record: TargetWorkspaceRecord = {
      id: workspaceId,
      bindingId,
      path: candidate.path,
      generation: randomUUID(),
      adminIdentity: candidate.adminIdentity,
      instanceMarker: await this.marker.assign(candidate.adminPath, "workspace"),
      kind: candidate.kind,
      branch: candidate.branch,
      head: candidate.head,
      lifecycle: "active",
    };
    await this.save({ ...this.state, workspaces: [...this.state.workspaces, record] });
    return record;
  }

  adopt(request: {
    bindingId: string;
    workspaceId: string;
    worktreePath: string;
  }): Promise<TargetWorkspaceRecord> {
    return this.exclusive(() =>
      this.adoptCandidate(request.bindingId, request.workspaceId, request.worktreePath),
    );
  }
  create(request: CreateTargetWorktreeRequest): Promise<TargetWorkspaceRecord> {
    return this.exclusive(async () => {
      const binding = this.binding(request.bindingId);
      if ((this.state.archivedBindings ?? []).includes(binding.id))
        throw new Error("Repository binding archived");
      await this.inspectBinding(binding);
      if (
        !request.workspaceId ||
        this.state.workspaces.some((item) => item.id === request.workspaceId)
      )
        throw new Error("Workspace ID already registered");
      await createGitWorktree({
        repositoryPath: binding.repositoryPath,
        path: request.worktreePath,
        branch: request.branch,
        mode: request.mode,
        baseRef: request.baseRef,
      });
      // Git 成功而登记失败时不回滚用户的树/分支；扫描会重新发现未登记候选。
      return this.adoptCandidate(request.bindingId, request.workspaceId, request.worktreePath);
    });
  }

  /** A path match is never evidence of the same repository instance. */
  matchesBinding(bindingId: string, repositoryPath: string): Promise<boolean> {
    return this.exclusive(async () => {
      try {
        await this.inspectBinding(this.binding(bindingId), repositoryPath);
        return true;
      } catch {
        return false;
      }
    });
  }

  /** Persist target admission denial before archive metadata, allowance only after metadata commit. */
  setArchivePolicy(kind: "binding" | "workspace", id: string, archived: boolean): Promise<void> {
    return this.exclusive(async () => {
      if (kind === "binding") this.binding(id);
      else this.workspace(id);
      const key = kind === "binding" ? "archivedBindings" : "archivedWorkspaces";
      const values = new Set(this.state[key] ?? []);
      if (archived) values.add(id);
      else values.delete(id);
      await this.save({ ...this.state, [key]: [...values] });
    });
  }

  private async verifiedCwd(
    workspaceId: string,
    expectedGeneration: string,
    cwdRelative: string,
  ): Promise<string> {
    if (this.frozen.has(workspaceId)) throw new Error("Workspace admission frozen");
    const record = this.workspace(workspaceId);
    if (
      (this.state.archivedWorkspaces ?? []).includes(workspaceId) ||
      (this.state.archivedBindings ?? []).includes(record.bindingId)
    )
      throw new Error("Workspace admission archived");
    await this.current(record, expectedGeneration);
    if (path.isAbsolute(cwdRelative) || cwdRelative.split(/[\\/]/).includes(".."))
      throw new Error("Cwd must be relative to worktree");
    return resolveGitWorktreeCwd(record.path, path.resolve(record.path, cwdRelative));
  }
  verify(workspaceId: string, expectedGeneration: string, cwdRelative: string): Promise<string> {
    return this.exclusive(() => this.verifiedCwd(workspaceId, expectedGeneration, cwdRelative));
  }
  withAdmission<T>(
    workspaceId: string,
    expectedGeneration: string,
    action: (canonicalCwd: string) => Promise<T>,
    cwdRelative = ".",
  ): Promise<T> {
    return this.exclusive(async () =>
      action(await this.verifiedCwd(workspaceId, expectedGeneration, cwdRelative)),
    );
  }

  previewRemoval(workspaceId: string, expectedGeneration: string): Promise<RemovalPreview> {
    return this.exclusive(async () => {
      let record: TargetWorkspaceRecord;
      try {
        record = await this.current(this.workspace(workspaceId), expectedGeneration, false);
      } catch {
        this.previews.delete(`${workspaceId}\0${expectedGeneration}`);
        return {
          workspaceId,
          generation: expectedGeneration,
          git: null,
          activity: null,
          unknown: true,
          safe: false,
        };
      }
      let git: GitRemovePreflight | null = null;
      let activity: TargetRuntimeActivity | null = null;
      let unknown = false;
      try {
        git = await preflightRemoveGitWorktree(
          this.binding(record.bindingId).repositoryPath,
          record.path,
        );
        activity = await this.options.activity(workspaceId);
        if (
          !activity ||
          activity.offline ||
          ![activity.running, activity.waiting, activity.tools, activity.uncertain].every(
            (n) => Number.isSafeInteger(n) && n >= 0,
          )
        )
          unknown = true;
      } catch {
        unknown = true;
      }
      const safe =
        !unknown &&
        record.kind === "linked" &&
        !!git &&
        !!activity &&
        !git.isMain &&
        !git.dirty &&
        !git.untracked &&
        !git.submodules &&
        !git.locked &&
        !git.prunable &&
        !git.gitLocks &&
        activity.running === 0 &&
        activity.waiting === 0 &&
        activity.tools === 0 &&
        activity.uncertain === 0;
      const key = `${workspaceId}\0${expectedGeneration}`;
      if (safe) this.previews.add(key);
      else this.previews.delete(key);
      return { workspaceId, generation: expectedGeneration, git, activity, unknown, safe };
    });
  }

  private async safeActivity(workspaceId: string): Promise<void> {
    const activity = await this.options.activity(workspaceId);
    if (
      !activity ||
      activity.offline ||
      ![activity.running, activity.waiting, activity.tools, activity.uncertain].every(
        (value) => Number.isSafeInteger(value) && value === 0,
      )
    )
      throw new Error("Runtime activity is busy or unknown");
  }
  remove(
    workspaceId: string,
    expectedGeneration: string,
    confirmed: boolean,
  ): Promise<TargetWorkspaceRecord> {
    if (!confirmed) return Promise.reject(new Error("Explicit removal confirmation required"));
    const key = `${workspaceId}\0${expectedGeneration}`;
    if (!this.previews.delete(key)) return Promise.reject(new Error("Removal preview required"));
    this.frozen.add(workspaceId);
    return this.exclusive(async () => {
      try {
        const record = await this.current(this.workspace(workspaceId), expectedGeneration);
        if (record.kind !== "linked") throw new Error("Only linked worktrees may be removed");
        await this.safeActivity(workspaceId);
        const binding = this.binding(record.bindingId);
        const preflight = await preflightRemoveGitWorktree(binding.repositoryPath, record.path);
        if (
          preflight.isMain ||
          preflight.dirty ||
          preflight.untracked ||
          preflight.submodules ||
          preflight.locked ||
          preflight.prunable ||
          preflight.gitLocks
        )
          throw new Error("Worktree removal has Git risks");
        await this.safeActivity(workspaceId);
        // 中文：预览后文件可改变；冻结 admission 后仍须重新检查，绝不以旧预览执行删除。
        const again = await preflightRemoveGitWorktree(binding.repositoryPath, record.path);
        if (
          again.isMain ||
          again.dirty ||
          again.untracked ||
          again.submodules ||
          again.locked ||
          again.prunable ||
          again.gitLocks
        )
          throw new Error("Worktree removal changed after preview");
        const pending: TargetWorkspaceRecord = { ...record, lifecycle: "pendingRemoval" };
        await this.save({
          ...this.state,
          workspaces: this.state.workspaces.map((item) =>
            item.id === workspaceId ? pending : item,
          ),
        });
        await removeGitWorktree(binding.repositoryPath, record.path);
        const removed: TargetWorkspaceRecord = { ...pending, lifecycle: "removed" };
        await this.save({
          ...this.state,
          workspaces: this.state.workspaces.map((item) =>
            item.id === workspaceId ? removed : item,
          ),
        });
        return removed;
      } finally {
        this.frozen.delete(workspaceId);
      }
    });
  }

  /** Read-only scan; a failed scan cannot erase or revise cached registration facts. */
  discover(bindingId: string): Promise<readonly RepositoryInspection["candidates"][number][]> {
    return this.exclusive(async () => {
      const inspected = await this.inspectBinding(this.binding(bindingId));
      return inspected.candidates.filter(
        (candidate) =>
          !this.state.workspaces.some(
            (item) =>
              item.bindingId === bindingId &&
              item.lifecycle !== "removed" &&
              candidate.adminIdentity &&
              sameFile(item.adminIdentity, candidate.adminIdentity),
          ),
      );
    });
  }

  reconcile(
    bindingId: string,
    repositoryPath?: string,
  ): Promise<
    | {
        status: "ok";
        candidates: RepositoryInspection["candidates"];
        records: readonly TargetWorkspaceRecord[];
      }
    | { status: "scanFailed"; error: unknown }
  > {
    return this.exclusive(async () => {
      let inspected: RepositoryInspection;
      try {
        inspected = await this.inspectBinding(this.binding(bindingId), repositoryPath);
      } catch (error) {
        return { status: "scanFailed" as const, error };
      }
      const workspaces = await Promise.all(
        this.state.workspaces.map((item) =>
          item.bindingId === bindingId
            ? reconcileWorkspace(item, inspected, (adminPath, marker) =>
                this.marker.matches(adminPath, "workspace", marker),
              )
            : item,
        ),
      );
      const verifiedPath =
        repositoryPath && (inspected.discovery.worktreeRoot ?? (await realpath(repositoryPath)));
      const bindings = verifiedPath
        ? this.state.bindings.map((item) =>
            item.id === bindingId ? { ...item, repositoryPath: verifiedPath } : item,
          )
        : this.state.bindings;
      await this.save({ ...this.state, workspaces, bindings });
      return {
        status: "ok" as const,
        candidates: inspected.candidates.filter(
          (candidate) =>
            !workspaces.some(
              (item) =>
                item.bindingId === bindingId &&
                item.lifecycle !== "removed" &&
                candidate.adminIdentity &&
                sameFile(item.adminIdentity, candidate.adminIdentity),
            ),
        ),
        records: workspaces.filter((item) => item.bindingId === bindingId),
      };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.exclusive(async () => {
      this.closed = true;
      await this.store.close();
    });
  }
}
export const openTargetWorktreeService = TargetWorktreeService.open;
