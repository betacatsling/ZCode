import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentCommandReceiptSchema, writableSessionSpecV2Schema, type AgentCommandReceipt, type SessionSpecV2 } from "@zcode/shared/agent-host";

const creationSchema = z.strictObject({
  commandId: z.string().trim().min(1).max(256),
  spec: writableSessionSpecV2Schema,
  receipt: agentCommandReceiptSchema,
});
export type CreationCommand = { spec: SessionSpecV2; receipt: AgentCommandReceipt };

function pathFor(root: string, commandId: string): string {
  return join(root, `${createHash("sha256").update(commandId).digest("hex")}.creation.json`);
}

/** A target-local, immutable command/spec reservation. Never retry an unconfirmed adapter create. */
export class CreationJournal {
  static async query(root: string, commandId: string): Promise<CreationCommand | undefined> {
    const id = creationSchema.shape.commandId.parse(commandId);
    let raw: string;
    try { raw = await readFile(pathFor(root, id), "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const row = creationSchema.parse(JSON.parse(raw));
    if (row.commandId !== id || row.receipt.commandId !== id) throw new Error("foreign creation command record");
    return { spec: row.spec, receipt: row.receipt.status === "accepted"
      ? { commandId: id, status: "execution-unknown", reasonCode: "execution-unknown" }
      : row.receipt };
  }

  static async listUnresolved(root: string, targetId: string, workspaceId?: string): Promise<SessionSpecV2[]> {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const unresolved: SessionSpecV2[] = [];
    for (const entry of entries) {
      if (!entry.name.endsWith(".creation.json") || !entry.isFile()) continue;
      const path = join(root, entry.name);
      if ((await stat(path)).size > 128 * 1024) throw new Error("oversized creation command; manual inspection required");
      const row = creationSchema.parse(JSON.parse(await readFile(path, "utf8")));
      if (entry.name !== `${createHash("sha256").update(row.commandId).digest("hex")}.creation.json` || row.receipt.commandId !== row.commandId)
        throw new Error("foreign creation command record");
      if (row.spec.execution.targetId === targetId && (workspaceId === undefined || row.spec.workspaceId === workspaceId) && row.receipt.status !== "completed")
        unresolved.push(row.spec);
    }
    return unresolved;
  }

  static async reserve(root: string, spec: SessionSpecV2, commandId: string): Promise<CreationCommand | undefined> {
    const row = creationSchema.parse({ commandId, spec, receipt: { commandId, status: "accepted" } });
    await mkdir(root, { recursive: true, mode: 0o700 });
    let handle;
    try { handle = await open(pathFor(root, row.commandId), "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await CreationJournal.query(root, row.commandId);
      if (!existing || JSON.stringify(existing.spec) !== JSON.stringify(row.spec)) throw new Error("creation command ID collision: different session spec");
      return existing;
    }
    try { await handle.writeFile(JSON.stringify(row)); await handle.sync(); }
    finally { await handle.close(); }
    return undefined;
  }

  static async finish(root: string, spec: SessionSpecV2, commandId: string): Promise<void> {
    const existing = await CreationJournal.query(root, commandId);
    if (!existing || JSON.stringify(existing.spec) !== JSON.stringify(spec) || existing.receipt.status !== "execution-unknown")
      throw new Error("invalid creation completion");
    const path = pathFor(root, commandId);
    const temporary = `${path}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(creationSchema.parse({ commandId, spec, receipt: { commandId, status: "completed" } })));
      await handle.sync();
    } finally { await handle.close(); }
    await rename(temporary, path);
  }
}
