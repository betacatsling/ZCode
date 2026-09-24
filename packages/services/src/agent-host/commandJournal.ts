import type { FileHandle } from "node:fs/promises";
import {
  agentCommandReceiptSchema,
  agentCommandSchema,
  frozenTurnModelRouteSchema,
  type FrozenTurnModelRoute,
  type AgentCommand,
  type AgentCommandReceipt,
} from "@zcode/shared/agent-host";
import { closeJournal, durableAppend, journalPath, openJournal, readJournalLines, type JournalIdentity } from "./journalStorage.js";

interface CommandRecord {
  command: AgentCommand;
  receipt: AgentCommandReceipt;
}

/** Accepted means durable admission, never completion. Unconfirmed dispatch is not replayed. */
export class CommandJournal {
  readonly #file: FileHandle;
  readonly #lock: FileHandle;
  readonly #lockPath: string;
  readonly #identity: JournalIdentity;
  readonly #root: string;
  readonly #records: Map<string, CommandRecord>;
  readonly #unknownAfterRestart: Set<string>;
  readonly #routes = new Map<string, FrozenTurnModelRoute>();
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #writeError?: unknown;

  private constructor(storage: Awaited<ReturnType<typeof openJournal>>, root: string, identity: JournalIdentity, records: Map<string, CommandRecord>) {
    this.#root = root;
    this.#file = storage.file;
    this.#lock = storage.lock;
    this.#lockPath = storage.lockPath;
    this.#identity = identity;
    this.#records = records;
    this.#unknownAfterRestart = new Set([...records].filter(([, record]) => record.receipt.status === "accepted").map(([id]) => id));
  }

  /** History query does not acquire the writer lease or create a missing journal. */
  static async queryHistory(root: string, identity: JournalIdentity, commandId: string): Promise<AgentCommandReceipt | undefined> {
    const { records } = CommandJournal.#parse(await readJournalLines(journalPath(root, identity, "commands")), identity);
    const receipt = records.get(commandId)?.receipt;
    return receipt?.status === "accepted"
      ? { commandId, status: "execution-unknown", reasonCode: "execution-unknown" }
      : receipt;
  }

  static #parse(lines: readonly string[], identity: JournalIdentity): { records: Map<string, CommandRecord>; routes: Map<string, FrozenTurnModelRoute> } {
    const records = new Map<string, CommandRecord>();
    const routes = new Map<string, FrozenTurnModelRoute>();
    for (const line of lines) {
      const raw = JSON.parse(line) as { command: unknown; receipt: unknown; frozenRoute?: unknown };
      if (raw.frozenRoute) {
        const route = frozenTurnModelRouteSchema.parse(raw.frozenRoute);
        const prior = routes.get(raw.command as string);
        if (prior || typeof raw.command !== "string") throw new Error("duplicate or corrupt frozen turn route");
        routes.set(raw.command, route);
        continue;
      }
      const command = agentCommandSchema.parse(raw.command);
      const receipt = agentCommandReceiptSchema.parse(raw.receipt);
      if (command.hostSessionId !== identity.hostSessionId || receipt.commandId !== command.commandId) throw new Error("foreign command journal record");
      const original = records.get(command.commandId);
      if (original && JSON.stringify(original.command) !== JSON.stringify(command)) throw new Error("command ID collision in journal");
      records.set(command.commandId, { command, receipt });
    }
    for (const [id, route] of routes) {
      const record = records.get(id);
      if (!record || record.command.type !== "send" || record.command.turnId !== route.turnId || route.runtimeEpoch !== identity.runtimeEpoch ||
        route.hostSessionId !== identity.hostSessionId) throw new Error("foreign frozen turn route");
    }
    return { records, routes };
  }

  static async open(root: string, identity: JournalIdentity): Promise<CommandJournal> {
    const storage = await openJournal(root, journalPath(root, identity, "commands"));
    try {
      const { records, routes } = CommandJournal.#parse(storage.lines, identity);
      const journal = new CommandJournal(storage, root, identity, records);
      for (const [id, route] of routes) journal.#routes.set(id, route);
      return journal;
    } catch (error) {
      await closeJournal(storage.file, storage.lock, storage.lockPath);
      throw error;
    }
  }

  accept(input: AgentCommand): Promise<AgentCommandReceipt> {
    const command = agentCommandSchema.parse(input);
    const run = this.#tail.then(async () => {
      if (this.#closed || this.#writeError) throw new Error("command journal write failed or closed; inspect before admitting commands");
      if (command.hostSessionId !== this.#identity.hostSessionId) throw new Error("foreign command identity");
      const existing = this.#records.get(command.commandId);
      if (existing) {
        if (JSON.stringify(existing.command) !== JSON.stringify(command)) throw new Error("duplicate-id: same commandId with a different payload");
        return { ...this.#safeReceipt(existing.receipt), status: "duplicate" as const };
      }
      const receipt = agentCommandReceiptSchema.parse({ commandId: command.commandId, status: "accepted" });
      try { await durableAppend(this.#file, journalPath(this.#root, this.#identity, "commands"), { command, receipt }); }
      catch (error) { this.#writeError = error; throw error; }
      this.#records.set(command.commandId, { command, receipt });
      return receipt;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  freezeTurn(commandId: string, route: FrozenTurnModelRoute): Promise<void> {
    const run = this.#tail.then(async () => {
      if (this.#closed || this.#writeError) throw new Error("command journal write failed or closed; inspect before admitting commands");
      const record = this.#records.get(commandId);
      const checked = frozenTurnModelRouteSchema.parse(route);
      if (!record || record.command.type !== "send" || record.command.turnId !== checked.turnId ||
        checked.runtimeEpoch !== this.#identity.runtimeEpoch || checked.hostSessionId !== this.#identity.hostSessionId ||
        this.#routes.has(commandId)) throw new Error("invalid frozen turn route");
      try { await durableAppend(this.#file, journalPath(this.#root, this.#identity, "commands"), { command: commandId, frozenRoute: checked }); }
      catch (error) { this.#writeError = error; throw error; }
      this.#routes.set(commandId, checked);
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }
  turnRoute(commandId: string): FrozenTurnModelRoute | undefined { return this.#routes.get(commandId); }

  finish(commandId: string, receipt: AgentCommandReceipt): Promise<void> {
    const run = this.#tail.then(async () => {
      if (this.#closed || this.#writeError) throw new Error("command journal write failed or closed; inspect before admitting commands");
      const original = this.#records.get(commandId);
      if (!original || receipt.commandId !== commandId || receipt.status === "accepted" || receipt.status === "duplicate") throw new Error("invalid command completion");
      if (original.receipt.status !== "accepted") throw new Error("command was already completed");
      const checked = agentCommandReceiptSchema.parse(receipt);
      try { await durableAppend(this.#file, journalPath(this.#root, this.#identity, "commands"), { command: original.command, receipt: checked }); }
      catch (error) { this.#writeError = error; throw error; }
      this.#records.set(commandId, { command: original.command, receipt: checked });
      this.#unknownAfterRestart.delete(commandId);
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  query(commandId: string): AgentCommandReceipt | undefined {
    const record = this.#records.get(commandId);
    return record && this.#safeReceipt(record.receipt);
  }

  static async hasUnresolvedHistory(root: string, identity: JournalIdentity): Promise<boolean> {
    const { records } = CommandJournal.#parse(await readJournalLines(journalPath(root, identity, "commands")), identity);
    return [...records.values()].some(({ receipt }) => receipt.status === "accepted" || receipt.status === "execution-unknown");
  }

  hasPendingSend(): boolean {
    return [...this.#records.values()].some(({ command, receipt }) => command.type === "send" && receipt.status === "accepted");
  }

  /** A lost backend acknowledgement cannot be turned into permission to run another prompt. */
  hasUncertainSend(): boolean {
    for (const [id, record] of this.#records) {
      if (record.command.type === "send" &&
          (this.#unknownAfterRestart.has(id) || record.receipt.status === "execution-unknown")) return true;
    }
    return false;
  }

  #safeReceipt(receipt: AgentCommandReceipt): AgentCommandReceipt {
    return receipt.status === "accepted" && this.#unknownAfterRestart.has(receipt.commandId)
      ? { commandId: receipt.commandId, status: "execution-unknown", reasonCode: "execution-unknown" }
      : receipt;
  }

  async close(): Promise<void> {
    await this.#tail;
    if (this.#closed) return;
    this.#closed = true;
    await closeJournal(this.#file, this.#lock, this.#lockPath);
  }
}
