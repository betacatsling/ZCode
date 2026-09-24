import type { FileHandle } from "node:fs/promises";
import {
  agentCommandReceiptSchema,
  agentCommandSchema,
  type AgentCommand,
  type AgentCommandReceipt,
} from "@zcode/shared/agent-host";
import { closeJournal, durableAppend, journalPath, openJournal, type JournalIdentity } from "./journalStorage.js";

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
  readonly #records: Map<string, CommandRecord>;
  readonly #unknownAfterRestart: Set<string>;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;

  private constructor(storage: Awaited<ReturnType<typeof openJournal>>, identity: JournalIdentity, records: Map<string, CommandRecord>) {
    this.#file = storage.file;
    this.#lock = storage.lock;
    this.#lockPath = storage.lockPath;
    this.#identity = identity;
    this.#records = records;
    this.#unknownAfterRestart = new Set([...records].filter(([, record]) => record.receipt.status === "accepted").map(([id]) => id));
  }

  static async open(root: string, identity: JournalIdentity): Promise<CommandJournal> {
    const storage = await openJournal(root, journalPath(root, identity, "commands"));
    try {
      const records = new Map<string, CommandRecord>();
      for (const line of storage.lines) {
        const raw = JSON.parse(line) as { command: unknown; receipt: unknown };
        const command = agentCommandSchema.parse(raw.command);
        const receipt = agentCommandReceiptSchema.parse(raw.receipt);
        if (command.hostSessionId !== identity.hostSessionId || receipt.commandId !== command.commandId) throw new Error("foreign command journal record");
        const original = records.get(command.commandId);
        if (original && JSON.stringify(original.command) !== JSON.stringify(command)) throw new Error("command ID collision in journal");
        records.set(command.commandId, { command, receipt });
      }
      return new CommandJournal(storage, identity, records);
    } catch (error) {
      await closeJournal(storage.file, storage.lock, storage.lockPath);
      throw error;
    }
  }

  accept(input: AgentCommand): Promise<AgentCommandReceipt> {
    const command = agentCommandSchema.parse(input);
    const run = this.#tail.then(async () => {
      if (this.#closed) throw new Error("journal closed");
      if (command.hostSessionId !== this.#identity.hostSessionId) throw new Error("foreign command identity");
      const existing = this.#records.get(command.commandId);
      if (existing) {
        if (JSON.stringify(existing.command) !== JSON.stringify(command)) throw new Error("duplicate-id: same commandId with a different payload");
        return { ...this.#safeReceipt(existing.receipt), status: "duplicate" as const };
      }
      const receipt = agentCommandReceiptSchema.parse({ commandId: command.commandId, status: "accepted" });
      await durableAppend(this.#file, { command, receipt });
      this.#records.set(command.commandId, { command, receipt });
      return receipt;
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  finish(commandId: string, receipt: AgentCommandReceipt): Promise<void> {
    const run = this.#tail.then(async () => {
      if (this.#closed) throw new Error("journal closed");
      const original = this.#records.get(commandId);
      if (!original || receipt.commandId !== commandId || receipt.status === "accepted" || receipt.status === "duplicate") throw new Error("invalid command completion");
      if (original.receipt.status !== "accepted") throw new Error("command was already completed");
      const checked = agentCommandReceiptSchema.parse(receipt);
      await durableAppend(this.#file, { command: original.command, receipt: checked });
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
