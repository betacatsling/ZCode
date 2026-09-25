import { createHash } from "node:crypto";
import { readFile, readdir, unlink, open } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ReadonlyNativeSessionMetadataView } from "@zcode/adapters/storage";
import { modelBindingRequestSchema, cwdRelativeToWorktreeSchema } from "@zcode/shared/agent-host";
import { z } from "zod";
import { atomicJsonWrite } from "../project-workspaces/profilePersistence.js";
import { createServiceLogger } from "../logger/serviceLogger.js";

const logger = createServiceLogger("native-create-journal");
export interface NativeCreateDiagnostic {
  /** Hash of the mapping filename, never a user path or a raw command identifier. */
  entryId: string;
  reason: "uncertified-mapping";
}

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
      JSON.stringify(fact.selection) !== JSON.stringify(intent.modelBinding.selection) ||
      // 中文：完成回执不能替代实际权限态；CLI 的不可变配置必须与 Core 唯一的 build 请求相符。
      JSON.stringify(fact.execution) !== JSON.stringify({ mode: "build", planEnabled: false })
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

  /** Read immutable ownership first; a foreign request must not probe its mapping or source DB. */
  async readIntent(commandId: string): Promise<NativeCreateIntent | undefined> {
    const raw = await readJson(this.path(commandId, "intent"));
    if (raw === undefined) return undefined;
    const intent = intentSchema.parse(raw);
    if (!isAbsolute(intent.nativeDatabasePath) || !isAbsolute(intent.workspacePath))
      throw new Error("native-create-path-not-absolute");
    if (intent.commandId !== commandId) throw new Error("native-create-intent-id-conflict");
    return intent;
  }

  /** Read-only recovery, even with new admission disabled; no CLI spawn, migration or replay. */
  async read(
    commandId: string,
  ): Promise<{ intent: NativeCreateIntent; mapping: NativeCreateMapping | undefined } | undefined> {
    const intent = await this.readIntent(commandId);
    if (!intent) return undefined;
    const mappingRaw = await readJson(this.path(commandId, "mapping"));
    if (mappingRaw === undefined) return { intent, mapping: undefined };
    const mapping = mappingSchema.parse(mappingRaw);
    const verified = await this.certified(intent);
    if (!verified || JSON.stringify(verified) !== JSON.stringify(mapping))
      throw new Error("native-create-mapping-source-conflict");
    return { intent, mapping };
  }

  /** Certify a source-completed CLI receipt without writing the missing Core mapping or Catalog ref. */
  async inspectCompleted(
    commandId: string,
  ): Promise<
    { intent: NativeCreateIntent; originalSessionId?: string; mapped: boolean } | undefined
  > {
    const state = await this.read(commandId);
    if (!state) return undefined;
    const certificate = state.mapping ?? (await this.certified(state.intent));
    return {
      intent: state.intent,
      ...(certificate ? { originalSessionId: certificate.originalSessionId } : {}),
      mapped: !!state.mapping,
    };
  }

  /** Only committed, individually source-certified mappings; no CLI spawn/migration on reads. */
  async listCompletedWithDiagnostics(): Promise<{
    rows: Array<{ intent: NativeCreateIntent; originalSessionId: string }>;
    diagnostics: NativeCreateDiagnostic[];
  }> {
    let files: string[];
    try {
      files = await readdir(this.root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { rows: [], diagnostics: [] };
      throw error;
    }
    const rows: Array<{ intent: NativeCreateIntent; originalSessionId: string }> = [];
    const diagnostics: NativeCreateDiagnostic[] = [];
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.mapping\.json$/.test(name))) {
      try {
        const mapping = mappingSchema.parse(await readJson(join(this.root, file)));
        if (file !== `${digest(mapping.commandId)}.mapping.json`)
          throw new Error("native-create-mapping-name-conflict");
        const state = await this.read(mapping.commandId);
        if (!state?.mapping) throw new Error("native-create-mapping-source-conflict");
        rows.push({ intent: state.intent, originalSessionId: mapping.originalSessionId });
      } catch {
        // 中文：一份映射/源库损坏不能遮蔽其他 CLI 已认证历史；不返回损坏 owner，
        // 也不写入修复或把故障解释为无业务记录。根目录读取失败仍向上抛出。
        diagnostics.push({ entryId: file.slice(0, 64), reason: "uncertified-mapping" });
      }
    }
    return { rows, diagnostics };
  }

  async listCompleted(): Promise<Array<{ intent: NativeCreateIntent; originalSessionId: string }>> {
    const { rows, diagnostics } = await this.listCompletedWithDiagnostics();
    for (const diagnostic of diagnostics)
      logger.warn(undefined, "quarantined uncertified native mapping", diagnostic);
    return rows;
  }

  /** Only a real completed SQLite fact can produce the durable NEW mapping. */
  async complete(commandId: string): Promise<NativeCreateMapping> {
    return this.serial(commandId, async () => {
      const state = await this.read(commandId);
      if (!state) throw new Error("native-create-intent-unavailable");
      if (state.mapping) return state.mapping;
      const mapping = await this.certified(state.intent);
      if (!mapping) throw new Error("native-create-receipt-uncertain");
      const path = this.path(commandId, "mapping");
      try {
        await atomicJsonWrite(path, mapping, () => {
          // 中文：故障必须发生在 rename 后、父目录 fsync 前；不能把未同步目录项报告为成功。
          if (process.env.ZCODE_CORE_NATIVE_MAPPING_FSYNC_FAULT_TEST_ONLY === commandId)
            throw new Error("native-create-mapping-directory-sync-fault-test-only");
        });
      } catch (error) {
        // 中文：旧实现失败时 rename 后的文件仍可能被随后 sidebar 当成成功映射；
        // 尽力回滚新目录项并同步清理。回滚失败保持 uncertain，绝不返回原始 ID。
        try {
          await unlink(path).catch((failure: NodeJS.ErrnoException) => {
            if (failure.code !== "ENOENT") throw failure;
          });
          const directory = await open(this.root, "r");
          try {
            await directory.sync();
          } finally {
            await directory.close();
          }
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "native-create-mapping-commit-and-rollback-uncertain",
          );
        }
        throw error;
      }
      return mapping;
    });
  }
}
