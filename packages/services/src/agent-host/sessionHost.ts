import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  agentCommandSchema, backendBindingSchema, bindingPlanSchema, executionTargetSchema,
  sessionSpecSchema, type AgentCommand, type AgentCommandReceipt, type AgentEvent,
  type BackendBinding, type BindingPlan, type ExecutionTarget, type SessionSpec,
  type StoredAgentSessionSummary,
} from "@zcode/shared/agent-host";
import { CommandJournal } from "./commandJournal.js";
import { EventJournal } from "./eventJournal.js";
import { HarnessRegistry, type HarnessAdapter } from "./harnessRegistry.js";
import type { JournalIdentity } from "./journalStorage.js";
import { planModelBinding, type ModelCatalogPort } from "./modelBindingPlanner.js";
import { projectHostConversation } from "../agent-ui-projection/projector.js";

const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: z.enum(["creating", "running", "terminated"]),
  spec: sessionSpecSchema,
  plan: bindingPlanSchema,
  binding: backendBindingSchema.optional(),
});
type Manifest = z.infer<typeof manifestSchema>;

export interface SessionHostOptions {
  root: string;
  spec: SessionSpec;
  target: ExecutionTarget;
  catalog: ModelCatalogPort;
  registry: HarnessRegistry;
}

/** One target-local owner. Renderer disconnect must NOT call close() on this service. */
export class SessionHost {
  readonly spec: SessionSpec;
  readonly binding: BackendBinding;
  readonly plan: BindingPlan;
  readonly #manifestPath: string;
  readonly #adapter: HarnessAdapter;
  readonly #commands: CommandJournal;
  readonly #events: EventJournal;
  readonly #listeners = new Set<(event: AgentEvent) => void>();
  readonly #active = new Set<Promise<void>>();
  readonly #interactions = new Map<string, string>();
  #activeTurn?: string;
  #eventTail: Promise<void> = Promise.resolve();
  #eventError?: Error;
  #unsubscribe: () => void;
  #closed = false;

  private constructor(options: {
    manifestPath: string; spec: SessionSpec; plan: BindingPlan; binding: BackendBinding;
    adapter: HarnessAdapter; commands: CommandJournal; events: EventJournal;
  }) {
    this.#manifestPath = options.manifestPath;
    this.spec = options.spec;
    this.plan = options.plan;
    this.binding = options.binding;
    this.#adapter = options.adapter;
    this.#commands = options.commands;
    this.#events = options.events;
    for (const event of this.#events.since(0)) this.#applyEventState(event);
    this.#unsubscribe = options.adapter.subscribe(options.spec.hostSessionId, (source) => {
      this.#eventTail = this.#eventTail.then(async () => {
        if (this.#eventError) return;
        const { event, appended } = await this.#events.appendWithStatus(source);
        if (!appended) return;
        this.#applyEventState(event);
        for (const listener of this.#listeners) listener(event);
      }).catch((error: unknown) => {
        this.#eventError = error instanceof Error ? error : new Error(String(error));
      });
    });
  }

  static async create(options: SessionHostOptions): Promise<SessionHost> {
    const spec = sessionSpecSchema.parse(options.spec);
    const target = executionTargetSchema.parse(options.target);
    const adapter = options.registry.require(spec.harness.id);
    const plan = await planModelBinding({ spec, target, harness: adapter, catalog: options.catalog });
    if (plan.support.support !== "supported") throw new Error(plan.support.reason ?? "unsupported model binding");
    const path = manifestPath(options.root, spec);
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    // Mark an in-flight create before backend launch. Crash at this point is unknown, not retried.
    const handle = await open(path, "wx", 0o600);
    try {
      const initial = manifestSchema.parse({ schemaVersion: 1, state: "creating", spec, plan });
      await handle.writeFile(JSON.stringify(initial));
      await handle.sync();
    } finally {
      await handle.close();
    }
    const binding = backendBindingSchema.parse(await adapter.create(spec, plan));
    if (binding.hostSessionId !== spec.hostSessionId || binding.backendVersion !== adapter.version) throw new Error("backend identity mismatch");
    await saveManifest(path, { schemaVersion: 1, state: "running", spec, plan, binding });
    return SessionHost.#mount(options.root, path, spec, plan, binding, adapter);
  }

  static async open(options: SessionHostOptions): Promise<SessionHost> {
    const spec = sessionSpecSchema.parse(options.spec);
    const path = manifestPath(options.root, spec);
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
    if (JSON.stringify(manifest.spec) !== JSON.stringify(spec)) throw new Error("session identity or configuration mismatch");
    if (!manifest.binding || manifest.state === "creating") throw new Error("execution-unknown: backend create was not confirmed");
    if (manifest.state === "terminated") throw new Error("terminated session is history-only; never restart its backend");
    const adapter = options.registry.require(spec.harness.id);
    if (adapter.version !== manifest.binding.backendVersion) throw new Error("backend version mismatch: history only");
    const host = await SessionHost.#mount(options.root, path, spec, manifest.plan, manifest.binding, adapter);
    try { await adapter.attach(spec, manifest.binding, host.snapshot().seq, manifest.plan); } catch (error) { await host.close(); throw error; }
    return host;
  }

  /** Read-only recovery path: does not load an adapter, call a Provider or start a worker. */
  static async snapshotHistory(root: string, spec: SessionSpec) {
    const { binding, identity } = await SessionHost.#storedHistory(root, spec);
    const journal = await EventJournal.open(root, identity);
    try {
      const events: AgentEvent[] = [];
      while (true) {
        const batch = journal.since(events.length);
        events.push(...batch);
        if (batch.length < 500) break;
      }
      return projectHostConversation({ spec, runtimeEpoch: binding.runtimeEpoch, events });
    } finally { await journal.close(); }
  }

  static async eventsSinceHistory(root: string, spec: SessionSpec, sequence: number): Promise<readonly AgentEvent[]> {
    const { identity } = await SessionHost.#storedHistory(root, spec);
    const journal = await EventJournal.open(root, identity);
    try { return journal.since(sequence); } finally { await journal.close(); }
  }

  static async queryCommandHistory(root: string, spec: SessionSpec, commandId: string): Promise<AgentCommandReceipt | undefined> {
    const { identity } = await SessionHost.#storedHistory(root, spec);
    const journal = await CommandJournal.open(root, identity);
    try { return journal.query(commandId); } finally { await journal.close(); }
  }

  /** Target-local sidecar index; never inserts external sessions into native CLI storage. */
  static async listStoredSessions(root: string, input: {
    targetId: string; workspaceIdentity: string; worktreePath: string;
  }): Promise<StoredAgentSessionSummary[]> {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const summaries: StoredAgentSessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".session.json")) continue;
      const path = join(root, entry.name);
      const metadata = await stat(path);
      if (metadata.size > 128 * 1024) throw new Error("oversized external session manifest; manual inspection required");
      const value: unknown = JSON.parse(await readFile(path, "utf8"));
      const parsed = manifestSchema.safeParse(value);
      if (!parsed.success) throw new Error("unreadable or future external session manifest; refusing to hide history");
      const manifest = parsed.data;
      if (manifest.spec.execution.targetId !== input.targetId ||
          manifest.spec.execution.workspaceIdentity !== input.workspaceIdentity ||
          manifest.spec.execution.worktreePath !== input.worktreePath) continue;
      summaries.push({ spec: manifest.spec, state: manifest.state, updatedAt: metadata.mtimeMs });
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  static async #storedHistory(root: string, raw: SessionSpec): Promise<{ binding: BackendBinding; identity: JournalIdentity }> {
    const spec = sessionSpecSchema.parse(raw);
    const manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath(root, spec), "utf8")));
    if (JSON.stringify(manifest.spec) !== JSON.stringify(spec)) throw new Error("session identity or configuration mismatch");
    if (!manifest.binding) throw new Error("execution-unknown: backend create was not confirmed");
    return {
      binding: manifest.binding,
      identity: {
        targetId: spec.execution.targetId, workspaceIdentity: spec.execution.workspaceIdentity,
        harnessId: spec.harness.id, hostSessionId: spec.hostSessionId,
        runtimeEpoch: manifest.binding.runtimeEpoch,
      },
    };
  }

  static async #mount(root: string, path: string, spec: SessionSpec, plan: BindingPlan, binding: BackendBinding, adapter: HarnessAdapter): Promise<SessionHost> {
    const identity: JournalIdentity = {
      targetId: spec.execution.targetId,
      workspaceIdentity: spec.execution.workspaceIdentity,
      harnessId: spec.harness.id,
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: binding.runtimeEpoch,
    };
    const events = await EventJournal.open(root, identity);
    try {
      const commands = await CommandJournal.open(root, identity);
      return new SessionHost({ manifestPath: path, spec, plan, binding, adapter, commands, events });
    } catch (error) { await events.close(); throw error; }
  }

  async dispatch(raw: AgentCommand): Promise<AgentCommandReceipt> {
    if (this.#closed) throw new Error("session host closed");
    if (this.#eventError) throw this.#eventError;
    const command = agentCommandSchema.parse(raw);
    if (command.hostSessionId !== this.spec.hostSessionId) throw new Error("foreign session command");
    const receipt = await this.#commands.accept(command);
    if (receipt.status === "duplicate") return receipt;
    await this.#eventTail;
    if (this.#closed) return this.#reject(command, "backend-failure", "session host is closing");
    if (this.#eventError) return this.#reject(command, "backend-failure", "event stream is no longer reliable");
    if (command.type === "send") {
      if (this.#commands.hasUncertainSend()) {
        return this.#reject(command, "execution-unknown", "previous prompt may have executed; inspect history before explicit recovery");
      }
      if (this.#activeTurn) return this.#reject(command, "unsupported", "session busy");
      this.#activeTurn = command.turnId;
      try {
        const run = this.#adapter.send(command);
        this.#track(command.commandId, command.turnId, run);
        return receipt;
      } catch (error) {
        this.#activeTurn = undefined;
        return this.#reject(command, "backend-failure", error instanceof Error ? error.message : "backend failed");
      }
    }
    try {
      switch (command.type) {
        case "cancelTurn":
          if (!this.#isCurrentTurn(command)) return this.#reject(command, "stale-turn", "turn or epoch changed");
          await this.#adapter.cancelTurn(command);
          break;
        case "resolveInteraction":
          if (!this.#isCurrentTurn(command) || this.#interactions.get(command.interactionId) !== command.turnId) {
            return this.#reject(command, "stale-interaction", "interaction or epoch changed");
          }
          await this.#adapter.resolveInteraction(command);
          break;
        case "detach": // Closing a UI subscription never touches the target worker.
        case "viewHistory":
          break;
        case "terminateSession":
          await this.#adapter.terminate(this.spec.hostSessionId);
          await saveManifest(this.#manifestPath, { schemaVersion: 1, state: "terminated", spec: this.spec, plan: this.plan, binding: this.binding });
          break;
        case "resumeExecution":
          return this.#reject(command, "unsupported", "backend native resume is not implemented");
        case "createSession":
          return this.#reject(command, "duplicate-id", "session already created");
      }
      const done: AgentCommandReceipt = { commandId: command.commandId, status: "completed" };
      await this.#commands.finish(command.commandId, done);
      return done;
    } catch (error) {
      return this.#reject(command, "backend-failure", error instanceof Error ? error.message : "backend failed");
    }
  }

  eventsSince(sequence: number): readonly AgentEvent[] { return this.#events.since(sequence); }
  snapshot() {
    const events: AgentEvent[] = [];
    while (true) {
      const batch = this.#events.since(events.length);
      events.push(...batch);
      if (batch.length < 500) break;
    }
    return projectHostConversation({ spec: this.spec, runtimeEpoch: this.binding.runtimeEpoch, events });
  }
  queryCommand(commandId: string): AgentCommandReceipt | undefined { return this.#commands.query(commandId); }
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  async whenEventsSettled(): Promise<void> {
    await this.#eventTail;
    if (this.#eventError) throw this.#eventError;
  }
  async whenIdle(): Promise<void> {
    await Promise.all(this.#active);
    await this.whenEventsSettled();
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.#active.size) throw new Error("active turn: detach a client, cancel the turn or terminate the session before closing the host");
    await this.whenIdle();
    this.#closed = true;
    this.#unsubscribe();
    await this.#commands.close();
    await this.#events.close();
  }

  #track(commandId: string, turnId: string, run: Promise<void>): void {
    const tracked = run.then(async () => {
      await this.#eventTail;
      if (this.#eventError || this.#activeTurn === turnId) {
        await this.#commands.finish(commandId, { commandId, status: "execution-unknown", reasonCode: "execution-unknown" });
      } else {
        await this.#commands.finish(commandId, { commandId, status: "completed" });
      }
    }, async () => {
      await this.#eventTail;
      await this.#commands.finish(commandId, { commandId, status: "execution-unknown", reasonCode: "execution-unknown" });
    });
    this.#active.add(tracked);
    void tracked.then(() => this.#active.delete(tracked), () => this.#active.delete(tracked));
  }
  #isCurrentTurn(command: { runtimeEpoch: string; turnId: string }): boolean {
    return command.runtimeEpoch === this.binding.runtimeEpoch && command.turnId === this.#activeTurn;
  }
  #applyEventState(event: AgentEvent): void {
    if (event.kind === "turn.started") this.#activeTurn = event.turnId;
    if (event.kind === "interaction.requested") this.#interactions.set(event.interactionId, event.turnId);
    if (event.kind === "interaction.resolved") this.#interactions.delete(event.interactionId);
    if (event.kind === "turn.finished") {
      if (this.#activeTurn && event.turnId !== this.#activeTurn) throw new Error("out-of-order turn completion");
      this.#activeTurn = undefined;
      this.#interactions.clear();
    }
  }
  async #reject(command: AgentCommand, reasonCode: NonNullable<AgentCommandReceipt["reasonCode"]>, message: string): Promise<AgentCommandReceipt> {
    const receipt: AgentCommandReceipt = { commandId: command.commandId, status: "rejected", reasonCode, message };
    await this.#commands.finish(command.commandId, receipt);
    return receipt;
  }
}

function manifestPath(root: string, spec: SessionSpec): string {
  const identity = [spec.execution.targetId, spec.execution.workspaceIdentity, spec.harness.id, spec.hostSessionId];
  return join(root, `${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}.session.json`);
}

async function saveManifest(path: string, value: Manifest): Promise<void> {
  const checked = manifestSchema.parse(value);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(checked), { mode: 0o600 });
  await rename(tmp, path);
}
