import { realpath } from "node:fs/promises";
import type { AgentCommand, AgentCommandReceipt, AgentEvent, ExecutionTarget, SessionSpec, StoredAgentSessionSummary } from "@zcode/shared/agent-host";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import { HarnessRegistry } from "./harnessRegistry.js";
import { SessionHost } from "./sessionHost.js";
import type { ModelCatalogPort } from "./modelBindingPlanner.js";

export interface TargetHostEvent { spec: SessionSpec; event: AgentEvent }

/**
 * Opt-in target process owner. Client disconnect only drops a callback; it never
 * terminates a worker or reissues an accepted prompt.
 */
export class AgentHostTargetService {
  readonly #root: string;
  readonly #target: ExecutionTarget;
  readonly #catalog: ModelCatalogPort;
  readonly #registry: HarnessRegistry;
  readonly #authorizeWorktree: (spec: SessionSpec, realWorktreePath: string) => Promise<boolean>;
  readonly #hosts = new Map<string, SessionHost>();
  readonly #owners = new Map<string, string>();
  readonly #listeners = new Set<(result: TargetHostEvent) => void>();

  constructor(options: {
    root: string;
    target: ExecutionTarget;
    catalog: ModelCatalogPort;
    registry: HarnessRegistry;
    authorizeWorktree: (spec: SessionSpec, realWorktreePath: string) => Promise<boolean>;
  }) {
    this.#root = options.root;
    this.#target = options.target;
    this.#catalog = options.catalog;
    this.#registry = options.registry;
    this.#authorizeWorktree = options.authorizeWorktree;
  }

  async getAvailability(): Promise<{ target: ExecutionTarget; harnesses: string[] }> {
    return { target: this.#target, harnesses: this.#registry.list().map((harness) => harness.id) };
  }
  async listSessions(workspaceIdentity: string, worktreePath: string): Promise<StoredAgentSessionSummary[]> {
    if (!this.#target.available) throw new Error("unauthorized execution target or worktree");
    await realpath(worktreePath); // must still exist; aliases are validated against each manifest in #verify.
    const records = await SessionHost.listStoredSessions(this.#root, {
      targetId: this.#target.id, workspaceIdentity, worktreePath,
    });
    for (const record of records) await this.#verify(record.spec);
    return records;
  }
  async create(spec: SessionSpec): Promise<ConversationSnapshot> {
    const key = await this.#verify(spec);
    if (this.#hosts.has(key)) throw new Error("duplicate external session owner");
    const host = await SessionHost.create({ root: this.#root, spec, target: this.#target, catalog: this.#catalog, registry: this.#registry });
    this.#mount(key, host);
    return host.snapshot();
  }
  async attach(spec: SessionSpec): Promise<ConversationSnapshot> {
    const key = await this.#verify(spec);
    const mounted = this.#hosts.get(key);
    if (mounted) { await mounted.whenEventsSettled(); return mounted.snapshot(); }
    const host = await SessionHost.open({ root: this.#root, spec, target: this.#target, catalog: this.#catalog, registry: this.#registry });
    this.#mount(key, host);
    return host.snapshot();
  }
  async dispatch(spec: SessionSpec, command: AgentCommand): Promise<AgentCommandReceipt> {
    const key = await this.#verify(spec);
    return this.#require(key).dispatch(command);
  }
  async snapshot(spec: SessionSpec): Promise<ConversationSnapshot> {
    const key = await this.#verify(spec);
    const host = this.#hosts.get(key);
    if (!host) return SessionHost.snapshotHistory(this.#root, spec);
    await host.whenEventsSettled();
    return host.snapshot();
  }
  async eventsSince(spec: SessionSpec, sequence: number): Promise<readonly AgentEvent[]> {
    const key = await this.#verify(spec);
    const host = this.#hosts.get(key);
    if (!host) return SessionHost.eventsSinceHistory(this.#root, spec, sequence);
    await host.whenEventsSettled();
    return host.eventsSince(sequence);
  }
  async queryCommand(spec: SessionSpec, commandId: string): Promise<AgentCommandReceipt | undefined> {
    const key = await this.#verify(spec);
    const host = this.#hosts.get(key);
    return host ? host.queryCommand(commandId) : SessionHost.queryCommandHistory(this.#root, spec, commandId);
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
    for (const harness of this.#registry.list()) await harness.shutdown?.();
    for (const host of this.#hosts.values()) {
      await host.whenIdle();
      await host.close();
    }
    this.#hosts.clear();
    this.#owners.clear();
    this.#listeners.clear();
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
    if (!host) throw new Error("external session is not attached; query history or explicitly attach first");
    return host;
  }
  async #verify(spec: SessionSpec): Promise<string> {
    if (spec.execution.targetId !== this.#target.id || !this.#target.available ||
      this.#target.platform !== process.platform ||
      !await this.#authorizeWorktree(spec, await realpath(spec.execution.worktreePath))) {
      throw new Error("unauthorized execution target or worktree");
    }
    const key = JSON.stringify([spec.execution.targetId, spec.execution.workspaceIdentity, spec.harness.id, spec.hostSessionId]);
    const owner = this.#owners.get(spec.hostSessionId);
    if (owner && owner !== key) throw new Error("host session ID belongs to another workspace");
    return key;
  }
}
