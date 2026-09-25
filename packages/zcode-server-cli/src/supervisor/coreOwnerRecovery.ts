import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDirFor, recoverStaleProfileOwnerLock } from "@zcode/services/node";
import type { ServerLayout } from "../runtime/paths.js";

/**
 * Supervisor 的 Core owner 启动记录。由持有 data-root 锁的唯一 Supervisor 实例
 * 在每次 launchCore 时原子覆盖写入；它构成可信证据链："本安装最近启动的 Core
 * 进程是 pid P"。记录只增不删，stop/crash 只影响新一次 launch 前的锁评估。
 */
export interface CoreOwnerRecord {
  readonly pid: number;
  readonly generation: number;
}

export function coreOwnerRecordPath(layout: ServerLayout): string {
  return join(layout.runDir, "core-owner.json");
}

/** 记录缺失或损坏都返回 null——损坏的记录不能当作任何 pid 的证据（fail-closed）。 */
export async function readCoreOwnerRecord(layout: ServerLayout): Promise<CoreOwnerRecord | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(coreOwnerRecordPath(layout), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
    (parsed as { pid: number }).pid <= 0 ||
    !Number.isSafeInteger((parsed as { generation?: unknown }).generation)
  )
    return null;
  return {
    pid: (parsed as { pid: number }).pid,
    generation: (parsed as { generation: number }).generation,
  };
}

export async function writeCoreOwnerRecord(
  layout: ServerLayout,
  record: CoreOwnerRecord,
): Promise<void> {
  // 与 statusSnapshot 相同的原子写形态：唯一临时名 + rename，避免半截 JSON。
  const path = coreOwnerRecordPath(layout);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

/** 与 Core 子进程解析一致：child env ZCODE_DATA_BASE_DIR = layout.dataBaseDir。 */
export function coreAuthorityProfilePath(layout: ServerLayout): string {
  return join(getAppConfigDirFor(layout.dataBaseDir), "core-authority.json");
}

export type CoreAuthorityRecovery =
  | { readonly kind: "clear" } // 锁不存在，正常启动
  | { readonly kind: "recovered"; readonly pid: number }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * launchCore 前的 Core profile 锁评估。仅在记录 pid 与 lock pid 精确匹配且该
 * 进程已整体消失（ESRCH=退出+被回收）时移除锁；其余一律拒绝且不产生任何副作用。
 * 该评估永远不重放已接受命令、不触碰 Catalog/Target/journal，只处理 Core 自有锁。
 */
export async function evaluateCoreAuthorityLock(
  layout: ServerLayout,
): Promise<CoreAuthorityRecovery> {
  const prior = await readCoreOwnerRecord(layout);
  if (!prior) {
    // 没有可信启动记录时无法证明 lock 中 pid 归属本安装——哪怕它是死进程也拒绝。
    const exists = await readFile(`${coreAuthorityProfilePath(layout)}.lock`, "utf8")
      .then(() => true)
      .catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      });
    if (!exists) return { kind: "clear" };
    return { kind: "refused", reason: "no trusted launch record for the existing owner" };
  }
  const outcome = await recoverStaleProfileOwnerLock(coreAuthorityProfilePath(layout), {
    expectedOwnerPid: prior.pid,
  });
  if (outcome.outcome === "absent") return { kind: "clear" };
  if (outcome.outcome === "recovered") return { kind: "recovered", pid: prior.pid };
  return { kind: "refused", reason: outcome.reason };
}
