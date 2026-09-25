import { randomUUID } from "node:crypto";
import { readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAppConfigDirFor, recoverStaleOwnerMarkers } from "@zcode/services/node";
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
export function coreConfigDir(layout: ServerLayout): string {
  return getAppConfigDirFor(layout.dataBaseDir);
}

/**
 * Core 进程持有的全部 owner marker。任一 marker 在 SIGKILL 后残留都会让下一代
 * Core 在对应 ProfileFileOwner/TargetAuthorityStore 打开时撞 EEXIST，因此恢复
 * 必须覆盖整个 managed 命名空间，而不是只清 authority 锁。journal `.lock` 和
 * sessionHost `.owner.json` 不在此列——前者有自己的存活探测自恢复策略，后者是
 * durable 意图记录而非进程锁。
 */
export async function managedCoreOwnerMarkers(layout: ServerLayout): Promise<string[]> {
  const configDir = coreConfigDir(layout);
  const markers = [
    join(configDir, "core-authority.json.lock"),
    join(configDir, "workspace-hierarchy", "profile", "catalog.json.lock"),
    join(configDir, "native-migration", "mapping.json.lock"),
  ];
  const targetDir = join(configDir, "workspace-hierarchy", "target");
  const entries = await readdir(targetDir).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [] as string[];
    throw error;
  });
  for (const entry of entries) {
    if (entry.endsWith(".owner")) markers.push(join(targetDir, entry));
  }
  return markers;
}

export type CoreAuthorityRecovery =
  | { readonly kind: "clear" } // 命名空间内无残留 owner marker，正常启动
  | { readonly kind: "recovered"; readonly pid: number }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * launchCore 前的 Core-owner marker 评估。仅当记录 pid 与每个 marker 的 pid
 * 精确匹配且该进程已整体消失（ESRCH=退出+被回收）时移除 marker；其余一律
 * 拒绝且不产生任何副作用（all-or-nothing preflight）。该评估永远不重放已
 * 接受命令、不触碰 Catalog/Target/journal 数据，只处理 Core 自有 owner marker。
 */
export async function evaluateCoreAuthorityLock(
  layout: ServerLayout,
): Promise<CoreAuthorityRecovery> {
  const prior = await readCoreOwnerRecord(layout);
  const markers = await managedCoreOwnerMarkers(layout);
  if (!prior) {
    // 没有可信启动记录时无法证明 marker 中 pid 归属本安装——哪怕它是死进程也拒绝。
    for (const marker of markers) {
      const exists = await readFile(marker, "utf8")
        .then(() => true)
        .catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        });
      if (exists) {
        return {
          kind: "refused",
          reason: `no trusted launch record for existing owner marker ${marker}`,
        };
      }
    }
    return { kind: "clear" };
  }
  const outcome = await recoverStaleOwnerMarkers(markers, { expectedOwnerPid: prior.pid });
  if (outcome.outcome === "clear") {
    return outcome.recoveredMarkers > 0 ? { kind: "recovered", pid: prior.pid } : { kind: "clear" };
  }
  return { kind: "refused", reason: `${outcome.reason}: ${outcome.marker}` };
}
