import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  sessionSpecSchema,
  type AgentHostSessionSummary,
  type AgentCommand,
  type AgentCommandReceipt,
  type AgentEvent,
  type ExecutionTarget,
  type SessionSpec,
  type StoredAgentSessionSummary,
  type ExternalWorkspaceSessionCreateRequest,
  type WorkspaceSessionBindingCapabilityRequest,
  type WorkspaceSessionCreateRequest,
  type WorkspaceSessionOwnersRequest,
} from "@zcode/shared/agent-host";
import {
  v4ConversationRowsRangeResultSchema,
  type ConversationSnapshot,
  type V4ConversationRowsRangeResult,
} from "@zcode/shared/zcode-protocol-v4";
import { HarnessRegistry } from "./harnessRegistry.js";
import { createHostHarnessDirectory, type HarnessDirectory } from "./harnessDirectory.js";
import { EventStreamFailure, SessionHost } from "./sessionHost.js";
import { createFileWorkspaceSessionReceiptStore } from "./workspaceSessionReceipts.js";
import type { ModelCatalogPort } from "./modelBindingPlanner.js";
import type { AgentHostActivityIndex } from "./activityIndex.js";
import type { IWorktreeService } from "../projectWorkspaceServices.js";
import {
  createWorkspaceSessionService,
  type NativeWorkspaceSessionOwnerPort,
  type WorkspaceAdmissionFenceChecker,
  type WorkspaceAdmissionRunner,
} from "./workspaceSessionService.js";
import { createTargetSessionIndex } from "./targetSessionIndex.js";
import { admitOwnedSession } from "./runtime/admissionLane.js";
import { createTargetOwnerGate } from "./runtime/ownerFence.js";

export type {
  NativeWorkspaceSessionOwnerPort,
  WorkspaceAdmissionFenceChecker,
  WorkspaceAdmissionRunner,
} from "./workspaceSessionService.js";

export type TargetHostEvent = { spec: SessionSpec; event: AgentEvent };

/** Target owner survives client detach and never replays accepted prompts. */
export class AgentHostTargetService {
  readonly #root: string;
  readonly #target: ExecutionTarget;
  readonly #catalog: ModelCatalogPort;
  readonly #registry: HarnessRegistry;
  readonly #authorizeWorktree: (spec: SessionSpec, realWorktreePath: string) => Promise<boolean>;
  readonly #workspaceAdmissionRunner?: WorkspaceAdmissionRunner;
  readonly #workspaceSessions: ReturnType<typeof createWorkspaceSessionService>;
  readonly #sessionIndex: ReturnType<typeof createTargetSessionIndex>;
  readonly #hosts = new Map<string, SessionHost>();
  readonly #owners = new Map<string, string>();
  /** Admission is serialized per host ID because adapters address live backends by that ID. */
  readonly #admissionTails = new Map<string, Promise<void>>();
  readonly #listeners = new Set<(result: TargetHostEvent) => void>();
  readonly #owner: ReturnType<typeof createTargetOwnerGate>;
  #closing = false;
  #closePromise?: Promise<void>;

  constructor(options: {
    root: string;
    target: ExecutionTarget;
    catalog: ModelCatalogPort;
    registry: HarnessRegistry;
    authorizeWorktree: (spec: SessionSpec, realWorktreePath: string) => Promise<boolean>;
    withWorkspaceAdmission?: WorkspaceAdmissionRunner;
    worktrees?: IWorktreeService;
    nativeOwner?: NativeWorkspaceSessionOwnerPort;
    checkAdmissionFence?: WorkspaceAdmissionFenceChecker;
    ownerGeneration?: number;
  }) {
    this.#root = options.root;
    this.#target = options.target;
    this.#catalog = options.catalog;
    this.#registry = options.registry;
    this.#authorizeWorktree = options.authorizeWorktree;
    this.#workspaceAdmissionRunner = options.withWorkspaceAdmission;
    this.#workspaceSessions = createWorkspaceSessionService({
      root: this.#root,
      target: this.#target,
      catalog: this.#catalog,
      registry: this.#registry,
      worktrees: options.worktrees,
      nativeOwner: options.nativeOwner,
      checkAdmissionFence: options.checkAdmissionFence,
      receipts: createFileWorkspaceSessionReceiptStore(
        join(this.#root, "workspace-session-receipts.json"),
      ),
      createExternal: (spec) => this.create(spec),
      createManagedExternal: (spec, receipt, title) =>
        this.#createManagedExternalSession(spec, receipt, title),
    });
    this.#sessionIndex = createTargetSessionIndex({
      root: this.#root,
      target: this.#target,
      verify: (spec) => this.#verify(spec),
      mounted: () => [...this.#hosts.values()],
    });
    this.#owner = createTargetOwnerGate({
      root: this.#root,
      targetId: this.#target.id,
      generation: options.ownerGeneration ?? 1,
    });
  }
  async getAvailability(): Promise<{ target: ExecutionTarget; harnesses: string[] }> {
    return { target: this.#target, harnesses: this.#registry.list().map((harness) => harness.id) };
  }
  async getDirectory(): Promise<HarnessDirectory> {
    return createHostHarnessDirectory({ registry: this.#registry });
  }
  listSessions(
    workspaceIdentity: string,
    worktreePath: string,
  ): Promise<StoredAgentSessionSummary[]> {
    return this.#sessionIndex.listSessions(workspaceIdentity, worktreePath);
  }
  listSessionSummaries(
    workspaceIdentity: string,
    worktreePath: string,
  ): Promise<AgentHostSessionSummary[]> {
    return this.#sessionIndex.listSessionSummaries(workspaceIdentity, worktreePath);
  }
  async listActivityIndex(): Promise<AgentHostActivityIndex> {
    await Promise.all([...this.#hosts.values()].map((host) => host.whenEventsSettled()));
    const stored = await SessionHost.listStoredActivityIndex(this.#root, this.#target.id);
    const mounted = new Map(
      [...this.#hosts.values()].map((host) => [
        this.#identityKey(host.spec),
        host.activityIndexEntry(),
      ]),
    );
    const sessions = stored.map((entry) => mounted.get(this.#identityKey(entry.spec)) ?? entry);
    return {
      targetId: this.#target.id,
      complete: true,
      sessions,
    };
  }
  async create(spec: SessionSpec): Promise<ConversationSnapshot> {
    return this.#runWithWorkspaceAdmission(spec, () =>
      this.#withAdmission(spec, async (parsed) => {
        const key = await this.#verify(parsed);
        if (this.#hosts.has(key)) throw new Error("duplicate external session owner");
        const host = await SessionHost.create({
          root: this.#root,
          spec: parsed,
          target: this.#target,
          catalog: this.#catalog,
          registry: this.#registry,
        });
        this.#mount(key, host);
        return host.snapshot();
      }),
    );
  }
  async attach(spec: SessionSpec): Promise<ConversationSnapshot> {
    return this.#runWithWorkspaceAdmission(spec, () =>
      this.#withAdmission(spec, async (parsed) => {
        const key = await this.#verify(parsed);
        const mounted = this.#hosts.get(key);
        if (mounted) {
          await mounted.whenEventsSettled();
          return mounted.snapshot();
        }
        const host = await SessionHost.open({
          root: this.#root,
          spec: parsed,
          target: this.#target,
          catalog: this.#catalog,
          registry: this.#registry,
        });
        this.#mount(key, host);
        return host.snapshot();
      }),
    );
  }
  async dispatch(spec: SessionSpec, command: AgentCommand): Promise<AgentCommandReceipt> {
    const admitted =
      command.type === "send" ||
      command.type === "createSession" ||
      command.type === "resumeExecution" ||
      (command.type === "resolveInteraction" && command.decision === "allow");
    const run = async () => {
      const key = admitted ? await this.#verify(spec) : this.#verifyHistory(spec);
      if (this.#closing) throw new Error("target host is closing");
      await this.#owner.assertIfHeld(spec.hostSessionId);
      return this.#require(key).dispatch(command);
    };
    return admitted ? this.#runWithWorkspaceAdmission(spec, run) : run();
  }
  createExternalForWorkspace(request: ExternalWorkspaceSessionCreateRequest) {
    return this.#workspaceSessions.createExternalForWorkspace(request);
  }
  createWorkspaceSession(request: WorkspaceSessionCreateRequest) {
    return this.#workspaceSessions.createWorkspaceSession(request);
  }
  getWorkspaceSessionCapability(request: WorkspaceSessionBindingCapabilityRequest) {
    return this.#workspaceSessions.getWorkspaceSessionCapability(request);
  }
  listWorkspaceSessionOwners(request: WorkspaceSessionOwnersRequest) {
    return this.#workspaceSessions.listWorkspaceSessionOwners(request);
  }
  async snapshot(spec: SessionSpec): Promise<ConversationSnapshot> {
    const key = this.#verifyHistory(spec);
    const host = this.#hosts.get(key);
    if (!host) return SessionHost.snapshotHistory(this.#root, spec);
    await host.whenEventsSettled();
    return host.snapshot();
  }
  async eventsSince(spec: SessionSpec, sequence: number): Promise<readonly AgentEvent[]> {
    const key = this.#verifyHistory(spec);
    const host = this.#hosts.get(key);
    if (!host) return SessionHost.eventsSinceHistory(this.#root, spec, sequence);
    await host.whenEventsSettled();
    return host.eventsSince(sequence);
  }
  async queryCommand(
    spec: SessionSpec,
    commandId: string,
  ): Promise<AgentCommandReceipt | undefined> {
    const key = this.#verifyHistory(spec);
    const host = this.#hosts.get(key);
    return host
      ? host.queryCommand(commandId)
      : SessionHost.queryCommandHistory(this.#root, spec, commandId);
  }
  async conversationRowsRange(
    spec: SessionSpec,
    input: { sessionId: string; beforeRowId?: number; limit: number },
  ): Promise<V4ConversationRowsRangeResult> {
    if (input.sessionId !== spec.hostSessionId) throw new Error("foreign session rows query");
    const key = this.#verifyHistory(spec);
    const host = this.#hosts.get(key);
    const snapshot = host
      ? host.snapshot({ windowSize: input.limit, beforeRowId: input.beforeRowId })
      : await SessionHost.snapshotHistory(this.#root, spec, {
          windowSize: input.limit,
          ...(input.beforeRowId === undefined ? {} : { beforeRowId: input.beforeRowId }),
        });
    const rows = snapshot.rows.window;
    const hasMore = rows[0] !== undefined && rows[0].rowId > 1;
    return v4ConversationRowsRangeResultSchema.parse({
      rows,
      atSeq: snapshot.seq,
      atRevision: snapshot.revision,
      atLogEpoch: snapshot.logEpoch,
      hasMore,
    });
  }
  async waitForIdle(spec: SessionSpec): Promise<ConversationSnapshot> {
    const key = await this.#verify(spec);
    const host = this.#require(key);
    await host.whenIdle();
    return host.snapshot();
  }
  subscribe(listener: (result: TargetHostEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#closePromise = this.#finishClose();
    return this.#closePromise;
  }

  async #createManagedExternalSession(
    spec: SessionSpec,
    creationRequest: { requestId: string; requestFingerprint: string },
    title?: string,
  ): Promise<boolean> {
    return this.#runWithWorkspaceAdmission(spec, () =>
      this.#withAdmission(spec, async (parsed) => {
        const key = await this.#verify(parsed);
        const prior = await SessionHost.findStoredCreation(
          this.#root,
          this.#target.id,
          creationRequest.requestId,
        );
        if (prior) {
          if (prior.requestFingerprint !== creationRequest.requestFingerprint) {
            throw new Error("workspace-session-idempotency-conflict");
          }
          return true;
        }
        if (this.#hosts.has(key)) throw new Error("duplicate external session owner");
        try {
          const host = await SessionHost.create({
            root: this.#root,
            spec: parsed,
            target: this.#target,
            catalog: this.#catalog,
            registry: this.#registry,
            ...(title ? { title } : {}),
            creationRequest,
          });
          this.#mount(key, host);
          return false;
        } catch (error) {
          const recovered = await SessionHost.findStoredCreation(
            this.#root,
            this.#target.id,
            creationRequest.requestId,
          );
          if (!recovered) throw error;
          if (recovered.requestFingerprint !== creationRequest.requestFingerprint) {
            throw new Error("workspace-session-idempotency-conflict", { cause: error });
          }
          return true;
        }
      }),
    );
  }

  #mount(key: string, host: SessionHost): void {
    this.#hosts.set(key, host);
    this.#owners.set(host.spec.hostSessionId, key);
    host.subscribe((event) => {
      for (const listener of this.#listeners) listener({ spec: host.spec, event });
    });
  }
  #require(key: string): SessionHost {
    const host = this.#hosts.get(key);
    if (!host)
      throw new Error("external session is not attached; query history or explicitly attach first");
    return host;
  }

  #withAdmission<T>(raw: SessionSpec, operation: (spec: SessionSpec) => Promise<T>): Promise<T> {
    return admitOwnedSession({
      raw,
      tails: this.#admissionTails,
      isClosing: () => this.#closing,
      owner: this.#owner,
      isMounted: (hostSessionId) => this.#owners.has(hostSessionId),
      operation,
    });
  }

  #runWithWorkspaceAdmission<T>(raw: SessionSpec, operation: () => Promise<T>): Promise<T> {
    const spec = sessionSpecSchema.parse(raw);
    return this.#workspaceAdmissionRunner
      ? this.#workspaceAdmissionRunner(spec, operation)
      : operation();
  }

  async #finishClose(): Promise<void> {
    // A create/attach that already acquired its lane must finish before adapter shutdown.
    while (this.#admissionTails.size) await Promise.all(this.#admissionTails.values());
    for (const harness of this.#registry.list()) await harness.shutdown?.();
    let failure: unknown;
    for (const host of this.#hosts.values()) {
      // whenIdle() stops waiting once a host's event stream is broken and close() then force-closes
      // it with EventStreamFailure; keep tearing down the other hosts and the owner fence first.
      const idle = await host.whenIdle().then(
        () => undefined,
        (error: unknown) => error ?? new Error("host failed to settle"),
      );
      try {
        await host.close();
      } catch (error) {
        if (!(error instanceof EventStreamFailure)) throw idle ?? error;
        failure ??= error;
        continue;
      }
      failure ??= idle;
    }
    this.#hosts.clear();
    this.#owners.clear();
    this.#listeners.clear();
    await this.#owner.releaseAll();
    if (failure !== undefined) throw failure;
  }

  async #verify(spec: SessionSpec): Promise<string> {
    if (
      spec.execution.targetId !== this.#target.id ||
      !this.#target.available ||
      this.#target.platform !== process.platform ||
      !(await this.#authorizeWorktree(spec, await realpath(spec.execution.worktreePath)))
    ) {
      throw new Error("unauthorized execution target or worktree");
    }
    const key = this.#identityKey(spec);
    const owner = this.#owners.get(spec.hostSessionId);
    if (owner && owner !== key) throw new Error("host session ID belongs to another workspace");
    return key;
  }

  #verifyHistory(raw: SessionSpec): string {
    const spec = sessionSpecSchema.parse(raw);
    if (spec.execution.targetId !== this.#target.id)
      throw new Error("unauthorized execution target or session history");
    const key = this.#identityKey(spec);
    const owner = this.#owners.get(spec.hostSessionId);
    if (owner && owner !== key) throw new Error("host session ID belongs to another workspace");
    return key;
  }

  #identityKey(spec: SessionSpec): string {
    return JSON.stringify([
      spec.execution.targetId,
      spec.execution.workspaceIdentity,
      spec.harness.id,
      spec.hostSessionId,
    ]);
  }
}
