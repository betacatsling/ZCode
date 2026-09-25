import type { Dirent } from "node:fs";
import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

/**
 * Managed Core occupancy recovery（docs/specs/core-occupancy-recovery.md）：
 * 只有可信 Supervisor —— 经私有 IPC 收到过该 owner 的 {pid, ownerEpoch, installationId}
 * 申报、且观察到该 child 句柄 exit/close（已被 OS 收割）—— 才允许退休其 marker。
 * 评估为 all-or-nothing：任何一把候选锁不可证明即整体拒绝，不做任何修改；
 * 退休阶段再逐文件 compare+unlink。本模块不感知进程对象，只消费 Supervisor 提供的
 * 已收割记录视图，便于独立单测。
 */
export interface ManagedOccupancyRecord {
  /** IPC 申报值，且必须等于 ChildProcess.pid。 */
  readonly pid: number;
  readonly generation: number;
  readonly ownerEpoch: string;
  readonly installationId: string;
  /** 仅当可信父进程观察到该 child 的 exit/close 后由 Supervisor 置为 true。 */
  reaped: boolean;
}

export class OccupancyRecoveryRefused extends Error {
  public constructor(
    readonly lockPath: string,
    reason: string,
  ) {
    super(`Core occupancy lock is not recoverable (${lockPath}): ${reason}`);
    this.name = "OccupancyRecoveryRefused";
  }
}

interface OccupancyLockContent {
  pid: number;
  ownerEpoch: string;
}

function errorCode(error: unknown): string {
  return error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : String(error);
}

async function listManagedCoreLockCandidates(configRoot: string): Promise<string[]> {
  // 与 createCoreAuthority 的 workspaceCompositionRoot（configRoot/workspace-hierarchy）
  // 下 lazy composition 实际打开的 occupancy marker 一一对应：
  //   ProfileFileOwner      — core-authority.json.lock、catalog.json.lock
  //   TargetAuthorityStore  — target/<sha256(targetId)>.owner
  // 绝不做 *.lock 通配扫描：journal、native-migration、server.lock 各有独立 owner
  // 策略（部分 owner 是 Core 之外的 agent 进程），不在本清单内，保持各自 fail-closed。
  const candidates = [
    join(configRoot, "core-authority.json.lock"),
    join(configRoot, "workspace-hierarchy", "profile", "catalog.json.lock"),
  ];
  const targetDir = join(configRoot, "workspace-hierarchy", "target");
  let entries: Dirent[];
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return candidates;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".owner")) {
      candidates.push(join(targetDir, entry.name));
    }
  }
  return candidates;
}

function parseOccupancyOwnerRecord(raw: string): OccupancyLockContent | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const record = parsed as { pid?: unknown; ownerEpoch?: unknown };
    const pid = record.pid;
    const ownerEpoch = record.ownerEpoch;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return undefined;
    if (typeof ownerEpoch !== "string" || ownerEpoch.length === 0) return undefined;
    return { pid: pid as number, ownerEpoch };
  } catch {
    return undefined;
  }
}

/**
 * 逐锁判定 + 退休 managed Core 残留的 occupancy marker；返回实际删除的路径。
 * 任何一把候选锁不合法/不可证明即 throw OccupancyRecoveryRefused，且保证此前未
 * 修改任何文件。调用方（Supervisor）必须在持有 server.lock、且无存活 Core 的
 * 窗口内调用。
 */
export async function recoverManagedOccupancyLocks(options: {
  configRoot: string;
  installationId: string;
  owners: ReadonlyMap<string, ManagedOccupancyRecord>;
}): Promise<string[]> {
  const candidates = await listManagedCoreLockCandidates(options.configRoot);
  const pending: { lockPath: string; raw: string }[] = [];
  for (const lockPath of candidates) {
    let raw: string | undefined;
    try {
      raw = await readFile(lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new OccupancyRecoveryRefused(lockPath, `cannot inspect: ${errorCode(error)}`);
    }
    const content = parseOccupancyOwnerRecord(raw);
    if (!content)
      throw new OccupancyRecoveryRefused(
        lockPath,
        "malformed or legacy owner record requires manual inspection",
      );
    const record = options.owners.get(content.ownerEpoch);
    if (!record || record.installationId !== options.installationId)
      throw new OccupancyRecoveryRefused(
        lockPath,
        "owner epoch is not an attested managed generation of this installation",
      );
    if (record.pid !== content.pid)
      throw new OccupancyRecoveryRefused(
        lockPath,
        "owner pid does not match the attested managed child",
      );
    if (!record.reaped)
      throw new OccupancyRecoveryRefused(
        lockPath,
        "owner generation has not been observed terminated and reaped",
      );
    pending.push({ lockPath, raw });
  }
  // 退休前重读：内容变化即放弃（JS 无法原子 compare+unlink，只能收窄窗口；
  // 残留文件保持 fail-closed 由人工处理）。评估已证明 owner 死亡的文件在
  // unlink 前消失视为已被并发恢复完成。
  const retired: string[] = [];
  for (const candidate of pending) {
    let current: string | undefined;
    try {
      current = await readFile(candidate.lockPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw new OccupancyRecoveryRefused(
        candidate.lockPath,
        `cannot re-verify before retire: ${errorCode(error)}`,
      );
    }
    if (current !== candidate.raw)
      throw new OccupancyRecoveryRefused(
        candidate.lockPath,
        "lock content changed during recovery",
      );
    try {
      await unlink(candidate.lockPath);
    } catch (error) {
      // 并发恢复中文件已被另一方删除：视为对方已完成退休，本调用不得冒领。
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    retired.push(candidate.lockPath);
  }
  return retired;
}
