import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { agentEventSchema, type AgentEvent } from "@zcode/shared/agent-host";
import { closeJournal, durableAppend, journalPath, openJournal, readJournalLines, type JournalIdentity } from "./journalStorage.js";

export class EventJournal {
  readonly #file: FileHandle;
  readonly #lock: FileHandle;
  readonly #lockPath: string;
  readonly #identity: JournalIdentity;
  readonly #root: string;
  readonly #events: AgentEvent[];
  readonly #bySource: Map<string, AgentEvent>;
  #tail: Promise<void> = Promise.resolve();
  #closed = false;
  #writeError?: unknown;

  private constructor(storage: Awaited<ReturnType<typeof openJournal>>, root: string, identity: JournalIdentity, events: AgentEvent[]) {
    this.#root = root;
    this.#file = storage.file;
    this.#lock = storage.lock;
    this.#lockPath = storage.lockPath;
    this.#identity = identity;
    this.#events = events;
    this.#bySource = new Map(events.map((event) => [event.sourceEventId ?? event.eventId, event]));
  }

  /** Sidecar replay never creates a journal or acquires its live owner's writer lock. */
  static async readHistory(root: string, identity: JournalIdentity): Promise<readonly AgentEvent[]> {
    return EventJournal.#parse(await readJournalLines(journalPath(root, identity, "events")), identity);
  }

  static async sinceHistory(root: string, identity: JournalIdentity, sequence: number): Promise<readonly AgentEvent[]> {
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("invalid journal cursor");
    return (await EventJournal.readHistory(root, identity)).slice(sequence, sequence + 500);
  }

  static #parse(lines: readonly string[], identity: JournalIdentity): AgentEvent[] {
    const events: AgentEvent[] = [];
    for (const line of lines) {
      const event = agentEventSchema.parse(JSON.parse(line));
      if (event.hostSessionId !== identity.hostSessionId || event.runtimeEpoch !== identity.runtimeEpoch || event.sequence !== events.length + 1)
        throw new Error("corrupt or foreign event journal");
      events.push(event);
    }
    return events;
  }

  static async open(root: string, identity: JournalIdentity): Promise<EventJournal> {
    const storage = await openJournal(root, journalPath(root, identity, "events"));
    try {
      return new EventJournal(storage, root, identity, EventJournal.#parse(storage.lines, identity));
    } catch (error) {
      await closeJournal(storage.file, storage.lock, storage.lockPath);
      throw error;
    }
  }

  /** Source sequence gaps require backend resync, not synthetic missing events. */
  async append(source: AgentEvent): Promise<AgentEvent> {
    return (await this.appendWithStatus(source)).event;
  }

  appendWithStatus(source: AgentEvent): Promise<{ event: AgentEvent; appended: boolean }> {
    const run = this.#tail.then(async () => {
      if (this.#writeError) throw this.#writeError;
      if (this.#closed) throw new Error("journal closed");
      const sourceId = source.sourceEventId ?? source.eventId;
      const existing = this.#bySource.get(sourceId);
      if (existing) {
        const replay = agentEventSchema.parse({ ...source, sourceEventId: sourceId, eventId: existing.eventId });
        if (JSON.stringify(existing) !== JSON.stringify(replay)) throw new Error("source event ID collision");
        return { event: existing, appended: false };
      }
      if (source.hostSessionId !== this.#identity.hostSessionId || source.runtimeEpoch !== this.#identity.runtimeEpoch) throw new Error("foreign event identity");
      if (source.sequence !== this.#events.length + 1) throw new Error("source event sequence gap or stale event");
      const event = agentEventSchema.parse({ ...source, sourceEventId: sourceId, eventId: randomUUID() });
      if (event.kind === "extension.event") {
        // 修复旧 journal 任意 JSON 扩展必须可读；新写入禁止携带未审查的嵌套数据、凭据或私有签名。
        if (event.payload !== "unsupported") throw new Error("unsafe extension event payload");
      }
      try { await durableAppend(this.#file, journalPath(this.#root, this.#identity, "events"), event); }
      catch (error) { this.#writeError = error; throw error; }
      this.#events.push(event);
      this.#bySource.set(sourceId, event);
      return { event, appended: true };
    });
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  get length(): number { return this.#events.length; }

  since(sequence: number, limit = 500): readonly AgentEvent[] {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("invalid journal cursor");
    return this.#events.slice(sequence, sequence + limit);
  }

  async close(): Promise<void> {
    await this.#tail;
    if (this.#closed) return;
    this.#closed = true;
    await closeJournal(this.#file, this.#lock, this.#lockPath);
  }
}
