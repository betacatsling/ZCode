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
import {
  TargetAuthorityStore,
  type TargetSnapshot,
  type TargetOperationReceipt,
} from "./targetAuthorityStore.js";
import type { RepositoryBinding } from "@zcode/shared/project-workspaces";
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
  /** Local fault-injection seam for crash testing; never supplied by RPC clients. */
  afterGitCreate?: () => Promise<void>;
  afterGitRemove?: () => Promise<void>;
}
export interface CreateTargetWorktreeRequest {
  bindingId: string;
  workspaceId: string;
  worktreePath: string;
  branch: string;
  mode: "new" | "existing";
  baseRef?: string;
  receipt?: { title: string; sortOrder: number; requestKey: string };
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
  /** Receipt identity is the original stable Catalog ID, never a path or branch match. */
  private receipt(
    kind: TargetOperationReceipt["kind"],
    id: string,
  ): TargetOperationReceipt | undefined {
    return this.state.operationReceipts?.find((row) => row.kind === kind && row.id === id);
  }
  private async reserve(receipt: TargetOperationReceipt): Promise<boolean> {
    const old = this.receipt(receipt.kind, receipt.id);
    if (old) {
      if (old.requestKey !== receipt.requestKey)
        throw new Error("Target operation ID reused with conflicting request");
      if (old.status !== "succeeded")
        throw new Error("Target operation outcome unknown; never retry effects");
      return false;
    }
    await this.save({
      ...this.state,
      operationReceipts: [...(this.state.operationReceipts ?? []), receipt],
    });
    return true;
  }
  private async finish(kind: TargetOperationReceipt["kind"], id: string, next: TargetSnapshot) {
    await this.save({
      ...next,
      operationReceipts: this.state.operationReceipts?.map((row) =>
        row.kind === kind && row.id === id ? { ...row, status: "succeeded" as const } : row,
      ),
    });
  }
  /** No Git probe can manufacture a receipt. A pending result is not an authoritative absence. */
  async lookupBinding(id: string): Promise<RepositoryBinding | undefined> {
    return this.exclusive(async () => {
      const receipt = this.receipt("import", id);
      if (!receipt) return undefined;
      if (receipt.status !== "succeeded" || !receipt.binding)
        throw new Error("Target binding result unknown");
      const record = this.binding(id);
      const inspected = await this.inspectBinding(record);
      if (
        record.projectId !== receipt.binding.projectId ||
        record.executionTargetId !== receipt.binding.executionTargetId ||
        (await realpath(receipt.binding.gitCommonDir)) !==
          (await realpath(inspected.discovery.gitCommonDir))
      )
        throw new Error("Target binding receipt mismatch");
      return { ...receipt.binding };
    });
  }
  async lookupWorkspace(
    id: string,
  ): Promise<{ record: TargetWorkspaceRecord; receipt: TargetOperationReceipt } | undefined> {
    return this.exclusive(async () => {
      const receipt =
        this.receipt("remove", id) ?? this.receipt("create", id) ?? this.receipt("adopt", id);
      if (!receipt) return undefined;
      if (receipt.status !== "succeeded") throw new Error("Target workspace result unknown");
      const record = this.workspace(id);
      if (receipt.kind === "remove") {
        if (record.lifecycle !== "removed") throw new Error("Target removal result unknown");
        await this.inspectBinding(this.binding(record.bindingId));
      } else {
        if (record.lifecycle !== "active") throw new Error("Target workspace result unknown");
        await this.current(record, record.generation, false);
      }
      return { record: { ...record }, receipt: { ...receipt } };
    });
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
  recoverCreation(
    workspaceId: string,
    review?: { reviewedAdminIdentity: FileIdentity },
  ): Promise<TargetWorkspaceRecord> {
    return this.exclusive(async () => {
      const intent = this.state.pendingCreations?.find((item) => item.workspaceId === workspaceId);
      if (!intent) throw new Error("No pending creation intent");
      const inspected = await this.inspectBinding(this.binding(intent.bindingId));
      const candidates = inspected.candidates.filter(
        (item) =>
          item.path === intent.worktreePath &&
          item.branch === `refs/heads/${intent.branch}` &&
          item.kind === "linked" &&
          item.prunable === null &&
          item.adminIdentity !== null &&
          item.adminPath !== null,
      );
      if (candidates.length !== 1) throw new Error("Creation candidate missing or ambiguous");
      if (
        this.receipt("create", workspaceId) &&
        (!review || !sameFile(candidates[0]!.adminIdentity!, review.reviewedAdminIdentity))
      )
        throw new Error(
          "Correlated orphan requires operator review of Git administrative identity",
        );
      // 中文：有 Catalog 回执的孤儿不能仅凭同路径/分支认领；操作员核对 Git 管理目录身份后才可显式恢复。
      return this.adoptCandidate(intent.bindingId, workspaceId, intent.worktreePath, true);
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
    receipt?: { binding: RepositoryBinding; requestKey: string };
  }): Promise<TargetBindingRecord> {
    return this.exclusive(async () => {
      if (request.receipt) {
        const prior = this.receipt("import", request.id);
        if (prior) {
          if (prior.requestKey !== request.receipt.requestKey || prior.status !== "succeeded")
            throw new Error("Target binding operation conflicting or unknown");
          const registered = this.binding(request.id);
          await this.inspectBinding(registered);
          return registered;
        }
      }
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
      if (request.receipt)
        await this.reserve({
          kind: "import",
          id: request.id,
          requestKey: request.receipt.requestKey,
          binding: request.receipt.binding,
          status: "pending",
        });
      const binding = {
        id: request.id,
        projectId: request.projectId,
        executionTargetId: request.executionTargetId,
        repositoryPath:
          inspected.discovery.worktreeRoot ?? (await realpath(request.repositoryPath)),
        commonIdentity: inspected.commonIdentity,
        instanceMarker: await this.marker.assign(inspected.discovery.gitCommonDir, "binding"),
      };
      const next = { ...this.state, bindings: [...this.state.bindings, binding] };
      if (request.receipt) await this.finish("import", request.id, next);
      else await this.save(next);
      return binding;
    });
  }

  private async adoptCandidate(
    bindingId: string,
    workspaceId: string,
    requestedPath: string,
    recoverPending = false,
    receipt?: { kind: "adopt" | "create"; title: string; sortOrder: number; requestKey: string },
  ): Promise<TargetWorkspaceRecord> {
    if (!workspaceId || this.state.workspaces.some((item) => item.id === workspaceId))
      throw new Error("Workspace ID already registered");
    const pending = this.state.pendingCreations?.find((item) => item.workspaceId === workspaceId);
    if (recoverPending !== !!pending)
      throw new Error("Pending creation requires explicit recovery");
    if (pending && (pending.bindingId !== bindingId || pending.worktreePath !== requestedPath))
      throw new Error("Creation intent does not match candidate");
    if ((this.state.archivedBindings ?? []).includes(bindingId))
      throw new Error("Repository binding archived");
    const inspected = await this.inspectBinding(this.binding(bindingId));
    const candidate = findCandidate(inspected, await realpath(requestedPath));
    if (
      !recoverPending &&
      this.state.pendingCreations?.some(
        (intent) => intent.bindingId === bindingId && intent.worktreePath === candidate?.path,
      )
    )
      throw new Error("Candidate reserved by pending creation; explicit recovery required");
    if (
      !candidate ||
      !candidate.adminIdentity ||
      !candidate.adminPath ||
      candidate.prunable !== null ||
      candidate.kind === "bare" ||
      (pending &&
        (candidate.kind !== "linked" ||
          candidate.path !== pending.worktreePath ||
          candidate.branch !== `refs/heads/${pending.branch}`))
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
    if (receipt?.kind === "adopt") {
      // 中文：先验证候选，再为会修改实例标记的认领写意图；无效输入不会占用原操作 ID。
      await this.reserve({
        kind: "adopt",
        id: workspaceId,
        requestKey: receipt.requestKey,
        status: "pending",
        presentation: {
          title: receipt.title,
          sortOrder: receipt.sortOrder,
          origin: "adopted",
        },
      });
    }
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
    const next = {
      ...this.state,
      workspaces: [...this.state.workspaces, record],
      pendingCreations: recoverPending
        ? (this.state.pendingCreations ?? []).filter((item) => item.workspaceId !== workspaceId)
        : this.state.pendingCreations,
    };
    if (receipt) await this.finish(receipt.kind, workspaceId, next);
    else if (this.receipt("create", workspaceId)) await this.finish("create", workspaceId, next);
    else await this.save(next);
    return record;
  }

  adopt(request: {
    bindingId: string;
    workspaceId: string;
    worktreePath: string;
    receipt?: { title: string; sortOrder: number; requestKey: string };
  }): Promise<TargetWorkspaceRecord> {
    return this.exclusive(async () => {
      if (request.receipt) {
        const old = this.receipt("adopt", request.workspaceId);
        if (old) {
          if (old.requestKey !== request.receipt.requestKey || old.status !== "succeeded")
            throw new Error("Target adoption conflicting or unknown");
          const record = this.workspace(request.workspaceId);
          await this.current(record, record.generation, false);
          return record;
        }
      }
      return this.adoptCandidate(
        request.bindingId,
        request.workspaceId,
        request.worktreePath,
        false,
        request.receipt && { ...request.receipt, kind: "adopt" },
      );
    });
  }
  create(request: CreateTargetWorktreeRequest): Promise<TargetWorkspaceRecord> {
    return this.exclusive(async () => {
      const binding = this.binding(request.bindingId);
      if (request.receipt) {
        const old = this.receipt("create", request.workspaceId);
        if (old) {
          if (old.requestKey !== request.receipt.requestKey || old.status !== "succeeded")
            throw new Error("Target creation conflicting or unknown; never replay Git");
          const record = this.workspace(request.workspaceId);
          await this.current(record, record.generation, false);
          return record;
        }
      }
      if ((this.state.archivedBindings ?? []).includes(binding.id))
        throw new Error("Repository binding archived");
      await this.inspectBinding(binding);
      if (
        !request.workspaceId ||
        this.state.workspaces.some((item) => item.id === request.workspaceId) ||
        this.state.pendingCreations?.some((item) => item.workspaceId === request.workspaceId)
      )
        throw new Error("Workspace ID already registered or creation result unknown");
      if (
        !path.isAbsolute(request.worktreePath) ||
        !request.branch ||
        !["new", "existing"].includes(request.mode)
      )
        throw new Error("Invalid creation request");
      const destination = path.join(
        await realpath(path.dirname(request.worktreePath)),
        path.basename(request.worktreePath),
      );
      if (
        this.state.pendingCreations?.some(
          (item) => item.bindingId === binding.id && item.worktreePath === destination,
        )
      )
        throw new Error("Destination reserved by pending creation");
      const intent: PendingTargetCreation = {
        workspaceId: request.workspaceId,
        bindingId: binding.id,
        worktreePath: destination,
        branch: request.branch,
        mode: request.mode,
        ...(request.baseRef === undefined ? {} : { baseRef: request.baseRef }),
      };
      const receipt = request.receipt && {
        kind: "create" as const,
        id: request.workspaceId,
        requestKey: request.receipt.requestKey,
        status: "pending" as const,
        presentation: {
          title: request.receipt.title,
          sortOrder: request.receipt.sortOrder,
          origin: "created" as const,
        },
      };
      await this.save({
        ...this.state,
        pendingCreations: [...(this.state.pendingCreations ?? []), intent],
        operationReceipts: receipt
          ? [...(this.state.operationReceipts ?? []), receipt]
          : this.state.operationReceipts,
      });
      await createGitWorktree({
        repositoryPath: binding.repositoryPath,
        path: destination,
        branch: request.branch,
        mode: request.mode,
        baseRef: request.baseRef,
      });
      await this.options.afterGitCreate?.();
      // 中文：Git 成功后登记失败保留意图和分支/目录；重试不能再次运行 Git。
      return this.adoptCandidate(request.bindingId, request.workspaceId, destination, true);
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
    receipt?: {
      title: string;
      sortOrder: number;
      origin: "adopted" | "created";
      requestKey: string;
    },
  ): Promise<TargetWorkspaceRecord> {
    if (!confirmed) return Promise.reject(new Error("Explicit removal confirmation required"));
    const key = `${workspaceId}\0${expectedGeneration}`;
    if (receipt && this.receipt("remove", workspaceId)) {
      const old = this.receipt("remove", workspaceId)!;
      if (old.requestKey !== receipt.requestKey || old.status !== "succeeded")
        return Promise.reject(new Error("Target removal conflicting or unknown"));
      return this.exclusive(async () => {
        const record = this.workspace(workspaceId);
        if (record.lifecycle !== "removed" || record.generation !== expectedGeneration)
          throw new Error("Target removal result unknown");
        await this.inspectBinding(this.binding(record.bindingId));
        return record;
      });
    }
    if (!this.previews.delete(key)) return Promise.reject(new Error("Removal preview required"));
    this.frozen.add(workspaceId);
    return this.exclusive(async () => {
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
        workspaces: this.state.workspaces.map((item) => (item.id === workspaceId ? pending : item)),
        operationReceipts: receipt
          ? [
              ...(this.state.operationReceipts ?? []),
              {
                kind: "remove",
                id: workspaceId,
                requestKey: receipt.requestKey,
                status: "pending",
                presentation: {
                  title: receipt.title,
                  sortOrder: receipt.sortOrder,
                  origin: receipt.origin,
                },
              } satisfies TargetOperationReceipt,
            ]
          : this.state.operationReceipts,
      });
      await removeGitWorktree(binding.repositoryPath, record.path);
      await this.options.afterGitRemove?.();
      const removed: TargetWorkspaceRecord = { ...pending, lifecycle: "removed" };
      const next = {
        ...this.state,
        workspaces: this.state.workspaces.map((item) => (item.id === workspaceId ? removed : item)),
      };
      if (receipt) await this.finish("remove", workspaceId, next);
      else await this.save(next);
      return removed;
    }).finally(() => {
      this.frozen.delete(workspaceId);
    });
  }

  /** Read-only scan; a failed scan cannot erase or revise cached registration facts. */
  discover(bindingId: string): Promise<readonly RepositoryInspection["candidates"][number][]> {
    return this.exclusive(async () => {
      const inspected = await this.inspectBinding(this.binding(bindingId));
      return inspected.candidates.filter(
        (candidate) =>
          !this.state.pendingCreations?.some(
            (intent) => intent.bindingId === bindingId && intent.worktreePath === candidate.path,
          ) &&
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
            !this.state.pendingCreations?.some(
              (intent) => intent.bindingId === bindingId && intent.worktreePath === candidate.path,
            ) &&
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
