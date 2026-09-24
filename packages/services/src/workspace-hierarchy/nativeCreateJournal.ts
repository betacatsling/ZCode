import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ReadonlyNativeSessionMetadataView } from "@zcode/adapters/storage";
import { modelBindingRequestSchema, cwdRelativeToWorktreeSchema } from "@zcode/shared/agent-host";
import { z } from "zod";
import { atomicJsonWrite } from "../project-workspaces/profilePersistence.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const intentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  commandId: z.string().min(1),
  targetId: z.string().min(1),
  projectId: z.string().min(1),
  workspaceId: z.string().min(1),
  repositoryBindingId: z.string().min(1),
  worktreeGeneration: z.string().min(1),
  workspaceIdentity: z.string().min(1),
  workspacePath: z.string().min(1),
  remoteSessionId: z.string().min(1).optional(),
  cwdRelativeToWorktree: cwdRelativeToWorktreeSchema,
  modelBinding: modelBindingRequestSchema,
  nativeDatabasePath: z.string().min(1),
  databaseId: hex,
  intentFingerprint: hex,
});
export type NativeCreateIntent = z.infer<typeof intentSchema>;
const mappingSchema = z.strictObject({
  schemaVersion: z.literal(1),
  commandId: z.string().min(1),
  intentDigest: hex,
  originalSessionId: z.string().min(1),
  nativeDatabasePath: z.string().min(1),
  databaseId: hex,
  intentFingerprint: hex,
});
type NativeCreateMapping = z.infer<typeof mappingSchema>;

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Core-only immutable intent + NEW mapping. Never writes CLI business rows or legacy backup sidecars. */
export class NativeCreateJournal {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(private readonly root: string) {}

  private path(commandId: string, kind: "intent" | "mapping"): string {
    return join(this.root, `${digest(commandId)}.${kind}.json`);
  }

  // 中文：同一进程的两个相同 command 可并发到达；ProfileFileOwner 只锁进程，
  // 不能让第二次 rename 覆盖第一次已落盘的意图/映射。
  private async serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.inflight.get(id);
    const result = (async () => {
      if (previous) await previous.catch(() => undefined);
      return action();
    })();
    this.inflight.set(id, result);
    try {
      return await result;
    } finally {
      if (this.inflight.get(id) === result) this.inflight.delete(id);
    }
  }

  async stage(value: NativeCreateIntent): Promise<void> {
    const intent = intentSchema.parse(value);
    if (!isAbsolute(intent.nativeDatabasePath) || !isAbsolute(intent.workspacePath))
      throw new Error("native-create-path-not-absolute");
    if (intent.databaseId !== digest(intent.nativeDatabasePath))
      throw new Error("native-create-storage-identity-mismatch");
    if (intent.workspaceIdentity !== intent.workspaceIdentity.trim())
      throw new Error("native-create-workspace-identity-invalid");
    await this.serial(intent.commandId, async () => {
      const path = this.path(intent.commandId, "intent");
      const prior = await readJson(path);
      if (prior !== undefined) {
        // 中文：已提交命令的重试必须逐字段同一意图；未知版本/腐坏文件不可覆盖后重新分配。
        if (JSON.stringify(intentSchema.parse(prior)) !== JSON.stringify(intent))
          throw new Error("native-create-intent-conflict");
        return;
      }
      await atomicJsonWrite(path, intent);
    });
  }

  private async certified(intent: NativeCreateIntent): Promise<NativeCreateMapping | undefined> {
    if (intent.databaseId !== digest(intent.nativeDatabasePath))
      throw new Error("native-create-storage-identity-mismatch");
    if (intent.modelBinding.kind !== "host-managed")
      throw new Error("native-create-unverifiable-model-binding");
    const fact = await new ReadonlyNativeSessionMetadataView(
      intent.nativeDatabasePath,
    ).readCertifiedCreateReceipt(intent.commandId, intent.workspaceIdentity);
    if (
      !fact ||
      fact.receipt.status !== "completed" ||
      fact.receipt.hasFirstInput ||
      fact.receipt.workspaceScope !== intent.workspaceIdentity ||
      fact.receipt.intentFingerprint !== intent.intentFingerprint ||
      fact.receipt.nativeDatabasePath !== intent.nativeDatabasePath ||
      fact.directory !== intent.workspacePath ||
      JSON.stringify(fact.selection) !== JSON.stringify(intent.modelBinding.selection)
    )
      return undefined;
    return {
      schemaVersion: 1,
      commandId: intent.commandId,
      intentDigest: digest(JSON.stringify(intent)),
      originalSessionId: fact.receipt.originalSessionId,
      nativeDatabasePath: intent.nativeDatabasePath,
      databaseId: intent.databaseId,
      intentFingerprint: intent.intentFingerprint,
    };
  }

  /** Read-only recovery, even with new admission disabled; no CLI spawn, migration or replay. */
  async read(
    commandId: string,
  ): Promise<{ intent: NativeCreateIntent; mapping: NativeCreateMapping | undefined } | undefined> {
    const raw = await readJson(this.path(commandId, "intent"));
    if (raw === undefined) return undefined;
    const intent = intentSchema.parse(raw);
    if (!isAbsolute(intent.nativeDatabasePath) || !isAbsolute(intent.workspacePath))
      throw new Error("native-create-path-not-absolute");
    if (intent.commandId !== commandId) throw new Error("native-create-intent-id-conflict");
    const mappingRaw = await readJson(this.path(commandId, "mapping"));
    if (mappingRaw === undefined) return { intent, mapping: undefined };
    const mapping = mappingSchema.parse(mappingRaw);
    const verified = await this.certified(intent);
    if (!verified || JSON.stringify(verified) !== JSON.stringify(mapping))
      throw new Error("native-create-mapping-source-conflict");
    return { intent, mapping };
  }

  /** Only a real completed SQLite fact can produce the durable NEW mapping. */
  async complete(commandId: string): Promise<NativeCreateMapping> {
    return this.serial(commandId, async () => {
      const state = await this.read(commandId);
      if (!state) throw new Error("native-create-intent-unavailable");
      if (state.mapping) return state.mapping;
      const mapping = await this.certified(state.intent);
      if (!mapping) throw new Error("native-create-receipt-uncertain");
      await atomicJsonWrite(this.path(commandId, "mapping"), mapping);
      return mapping;
    });
  }
}
