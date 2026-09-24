import { randomUUID } from "node:crypto";
import { open, readFile, rename, stat } from "node:fs/promises";
import { z } from "zod";
import type { AgentEvent } from "@zcode/shared/agent-host";
import { journalCommittedBytes, journalPath, type JournalIdentity } from "./journalStorage.js";
import { EventJournal } from "./eventJournal.js";
import { CommandJournal } from "./commandJournal.js";

const summarySchema = z.strictObject({
  version: z.literal(1), runtimeEpoch: z.string(), seq: z.number().int().nonnegative(),
  eventBytes: z.number().int().nonnegative(), commandBytes: z.number().int().nonnegative(),
  activity: z.enum(["idle", "running", "waiting", "uncertain"]),
  pendingSend: z.boolean(), lastOutcome: z.enum(["success", "failed", "cancelled", "unknown"]).optional(),
});
export type ActivitySummary = z.infer<typeof summarySchema>;
const pathFor = (root: string, identity: JournalIdentity) => journalPath(root, identity, "activity").replace(/\.jsonl$/, ".json");
const validated = new Map<string, string>();

export async function readActivitySummary(root: string, identity: JournalIdentity): Promise<ActivitySummary | undefined> {
  let raw: string;
  try { raw = await readFile(pathFor(root, identity), "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = summarySchema.parse(JSON.parse(raw));
  if (parsed.runtimeEpoch !== identity.runtimeEpoch) throw new Error("foreign activity summary");
  const [eventBytes, commandBytes] = await Promise.all([
    journalCommittedBytes(journalPath(root, identity, "events")), journalCommittedBytes(journalPath(root, identity, "commands")),
  ]);
  if (eventBytes === undefined || commandBytes === undefined || parsed.eventBytes !== eventBytes || parsed.commandBytes !== commandBytes) return undefined;
  const [eventFile, commandFile] = await Promise.all([
    stat(journalPath(root, identity, "events")), stat(journalPath(root, identity, "commands")),
  ]);
  if (eventFile.size !== eventBytes || commandFile.size !== commandBytes) return undefined;
  const key = JSON.stringify([parsed, eventFile.mtimeMs, eventFile.ctimeMs, commandFile.mtimeMs, commandFile.ctimeMs]);
  const path = pathFor(root, identity);
  if (validated.get(path) !== key) {
    // 冷启动或日志变更只验证一次连续权威记录；普通轮询只触碰轻量摘要和游标。
    const [events, unresolved] = await Promise.all([
      EventJournal.readHistory(root, identity), CommandJournal.hasUnresolvedHistory(root, identity),
    ]);
    if (events.length !== parsed.seq) throw new Error("activity summary sequence mismatch");
    let active = false;
    let unknown = false;
    let lastOutcome: ActivitySummary["lastOutcome"];
    const tools = new Set<string>();
    const approvals = new Set<string>();
    for (const event of events) {
      if (event.kind === "turn.started") active = true;
      if (event.kind === "turn.finished") { active = false; tools.clear(); approvals.clear(); lastOutcome = event.outcome; if (event.outcome === "unknown") unknown = true; }
      if (event.kind === "tool.started") tools.add(event.toolCallId);
      if (event.kind === "tool.finished") tools.delete(event.toolCallId);
      if (event.kind === "interaction.requested" || event.kind === "question.requested") approvals.add(event.interactionId);
      if (event.kind === "interaction.resolved" || event.kind === "question.answered") approvals.delete(event.interactionId);
      if (event.kind === "session.status" && (event.state === "execution-unknown" || event.state === "interrupted")) unknown = true;
      if (event.kind === "session.status" && event.state === "idle") unknown = false;
    }
    if (parsed.lastOutcome !== lastOutcome) throw new Error("activity summary outcome mismatch");
    if (parsed.activity === "idle" && (active || unknown || tools.size || approvals.size || unresolved))
      throw new Error("idle summary contradicts committed journal");
    validated.set(path, key);
  }
  return parsed;
}

/** Derived only after both journals have published their durable cursors; never admits a command. */
export async function publishActivitySummary(root: string, identity: JournalIdentity, input: {
  seq: number; activity: ActivitySummary["activity"]; pendingSend: boolean; lastOutcome?: ActivitySummary["lastOutcome"];
}): Promise<void> {
  const [eventBytes, commandBytes] = await Promise.all([
    journalCommittedBytes(journalPath(root, identity, "events")), journalCommittedBytes(journalPath(root, identity, "commands")),
  ]);
  if (eventBytes === undefined || commandBytes === undefined) throw new Error("missing committed journal cursor");
  const row = summarySchema.parse({ version: 1, runtimeEpoch: identity.runtimeEpoch, eventBytes, commandBytes, ...input });
  const path = pathFor(root, identity);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(row)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

export function observeOutcome(current: ActivitySummary["lastOutcome"], event: AgentEvent): ActivitySummary["lastOutcome"] {
  return event.kind === "turn.finished" ? event.outcome : current;
}
