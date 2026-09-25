import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

interface ParsedOwnerLock {
  raw: string;
  token: string;
  pid: number;
}

/** 读 owner lock；文件不存在返回 null，内容不符合 {token,pid} 结构返回 "malformed"。 */
async function readOwnerLock(lockPath: string): Promise<ParsedOwnerLock | null | "malformed"> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof (parsed as { token?: unknown }).token !== "string" ||
      !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
      (parsed as { pid: number }).pid <= 0
    )
      return "malformed";
    return {
      raw,
      token: (parsed as { token: string }).token,
      pid: (parsed as { pid: number }).pid,
    };
  } catch {
    return "malformed";
  }
}

// kill(pid,0) ESRCH 证明进程整体不存在（已退出且被回收；僵尸仍会应答 kill）。
// EPERM 表示进程存在但无权限，一律按存活处理（fail-closed）。
function ownerPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * quarantine-claim：先原子 rename 到隔离名，再回读验证内容仍是观察值。
 * 与直接 unlink 的区别：观察后若有第三方替换/改写 lock，claim 会还原而不是误删。
 */
async function claimObservedPath(path: string, expectedRaw: string): Promise<boolean> {
  const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
  const claimedRaw = await readFile(quarantine, "utf8").catch(() => null);
  if (claimedRaw === expectedRaw) {
    await rm(quarantine, { force: true });
    return true;
  }
  // 陈旧观察误 claim 了后来者时必须恢复，不能删除新 owner 的 lock。
  await rename(quarantine, path).catch(() => undefined);
  return false;
}

/**
 * `.recovery` 门栓串行化并发恢复者。持有者已死时先 claim 陈旧门栓再重试一次；
 * 持有者存活或两次都拿不到时返回 null（并发恢复 = 不确定，fail-closed）。
 */
async function tryAcquireRecoveryGate(gatePath: string): Promise<(() => Promise<void>) | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      handle = await open(gatePath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, ownerToken }), "utf8");
      await handle.close();
      const raw = JSON.stringify({ pid: process.pid, ownerToken });
      return async () => {
        // 只释放仍由本恢复者持有的门栓；已被替换的门栓不能误删。
        await claimObservedPath(gatePath, raw);
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        await handle?.close().catch(() => undefined);
        throw error;
      }
      const holder = await readOwnerLock(gatePath);
      if (holder === null || holder === "malformed" || ownerPidAlive(holder.pid)) return null;
      if (!(await claimObservedPath(gatePath, holder.raw))) return null;
    }
  }
  return null;
}

export type StaleOwnerRecoveryOutcome =
  | { readonly outcome: "recovered" }
  | { readonly outcome: "absent" }
  | {
      readonly outcome: "refused";
      readonly reason:
        | "malformed-owner"
        | "owner-identity-mismatch"
        | "owner-alive"
        | "recovery-concurrent"
        | "fence-lost";
    };

/**
 * owner marker → 其恢复门栓路径。`.lock` 族（ProfileFileOwner）沿用 data 文件
 * 的 `${path}.recovery` 约定；`.owner` 族（TargetAuthorityStore）沿用
 * `${leaseFile}.recovery` 约定。与各子系统自己的 operator recovery 共用同一门栓，
 * 保证可信 Supervisor 与 operator 恢复互斥。
 */
export function ownerMarkerRecoveryGatePath(markerPath: string): string {
  return markerPath.endsWith(".lock")
    ? `${markerPath.slice(0, -".lock".length)}.recovery`
    : `${markerPath}.recovery`;
}

/**
 * 可信 Supervisor 专用的 Core-owner marker 恢复：调用方必须独立证明
 * expectedOwnerPid 是自己启动并已回收的旧 owner（persisted launch record 或
 * 进程内 exit/close）。markerPath 是 marker 文件本身（`x.lock` 或 `x.owner`）。
 * 仅在内容合法、pid 与证据精确匹配、且该 pid 已不存在（ESRCH）时移除 marker；
 * 其余一切情况（畸形/异主/存活/EPERM/并发/fence 丢失）原样保留并拒绝。
 */
export async function recoverStaleProfileOwnerLock(
  markerPath: string,
  proof: { readonly expectedOwnerPid: number },
): Promise<StaleOwnerRecoveryOutcome> {
  // 快路径：marker 不存在时直接放行，不进恢复临界区——否则在目录尚未创建的
  // 全新环境（或锁已被正常释放）里写 `.recovery` 门栓会先 ENOENT 失败。
  if ((await readOwnerLock(markerPath)) === null) return { outcome: "absent" };
  const releaseGate = await tryAcquireRecoveryGate(ownerMarkerRecoveryGatePath(markerPath));
  if (!releaseGate) return { outcome: "refused", reason: "recovery-concurrent" };
  try {
    // 门栓内重读：快路径观察与拿门栓之间 marker 可能已被释放或替换。
    const observed = await readOwnerLock(markerPath);
    if (observed === null) return { outcome: "absent" };
    if (observed === "malformed") return { outcome: "refused", reason: "malformed-owner" };
    if (observed.pid !== proof.expectedOwnerPid)
      return { outcome: "refused", reason: "owner-identity-mismatch" };
    if (ownerPidAlive(observed.pid)) return { outcome: "refused", reason: "owner-alive" };
    // 断言与 claim 之间仍可能被替换：claim 内部回读验证捕获竞争。
    if (!(await claimObservedPath(markerPath, observed.raw)))
      return { outcome: "refused", reason: "fence-lost" };
    return { outcome: "recovered" };
  } finally {
    await releaseGate();
  }
}

export type ManagedMarkersRecovery =
  | {
      readonly outcome: "clear"; // 全部 managed marker 均不存在或已恢复
      readonly recoveredMarkers: number;
    }
  | { readonly outcome: "refused"; readonly reason: string; readonly marker: string };

/**
 * managed 命名空间内全部 Core-owner marker 的批量恢复，供可信 Supervisor 在
 * 每次 launch 前调用。两阶段：
 *   phase 1 只读 preflight：任一 marker 畸形或归属异主即整体拒绝（不改动任何文件）；
 *   phase 2 对每个 marker 走完整 verified 恢复（门栓 + ESRCH + quarantine-claim）。
 * phase 2 中途被拒时已 claim 的 marker 不回滚——每个 marker 的恢复幂等，下次
 * launch 重新评估剩余项即可，结果依然 fail-closed。
 */
export async function recoverStaleOwnerMarkers(
  markerPaths: readonly string[],
  proof: { readonly expectedOwnerPid: number },
): Promise<ManagedMarkersRecovery> {
  for (const marker of markerPaths) {
    const observed = await readOwnerLock(marker);
    if (observed === "malformed") return { outcome: "refused", reason: "malformed-owner", marker };
    if (observed !== null && observed.pid !== proof.expectedOwnerPid)
      return { outcome: "refused", reason: "owner-identity-mismatch", marker };
  }
  let recoveredMarkers = 0;
  for (const marker of markerPaths) {
    const result = await recoverStaleProfileOwnerLock(marker, proof);
    if (result.outcome === "refused") return { outcome: "refused", reason: result.reason, marker };
    if (result.outcome === "recovered") recoveredMarkers += 1;
  }
  return { outcome: "clear", recoveredMarkers };
}

/** Lock stealing is deliberately forbidden: after a crash recovery requires operator inspection. */
export class ProfileFileOwner {
  private constructor(
    readonly path: string,
    private readonly lock: FileHandle,
    private readonly token: string,
  ) {}

  static async open(path: string, recoverStaleOwner = false): Promise<ProfileFileOwner> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    if (recoverStaleOwner) {
      // 中文：operator 恢复路径仅用于非 Core owner；Core 锁必须走 verified
      // recoverStaleProfileOwnerLock（带独立证据的 expectedOwnerPid）。
      const releaseGate = await tryAcquireRecoveryGate(`${path}.recovery`);
      if (!releaseGate) throw new Error("profile-owner-recovery-concurrent");
      try {
        const previous = await readOwnerLock(`${path}.lock`);
        if (previous === "malformed") throw new Error("unknown-profile-owner");
        if (previous !== null) {
          if (ownerPidAlive(previous.pid)) throw new Error("profile-owner-still-running");
          if (!(await claimObservedPath(`${path}.lock`, previous.raw)))
            throw new Error("profile-owner-fence-lost");
        }
        return await this.create(path);
      } finally {
        await releaseGate();
      }
    }
    return this.create(path);
  }

  private static async create(path: string): Promise<ProfileFileOwner> {
    const lock = await open(`${path}.lock`, "wx", 0o600);
    const token = randomUUID();
    try {
      await lock.writeFile(JSON.stringify({ token, pid: process.pid }), "utf8");
      await lock.sync();
      return new ProfileFileOwner(path, lock, token);
    } catch (error) {
      await lock.close();
      await unlink(`${path}.lock`);
      throw error;
    }
  }

  private async assertLease(): Promise<void> {
    const parsed: unknown = JSON.parse(await readFile(`${this.path}.lock`, "utf8"));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as { token?: unknown }).token !== this.token
    )
      throw new Error("profile-owner-fence-lost");
  }

  async read(): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(value: unknown): Promise<void> {
    await this.assertLease();
    await atomicJsonWrite(this.path, value);
  }

  async remove(): Promise<void> {
    await this.assertLease();
    await unlink(this.path);
  }

  async close(): Promise<void> {
    await this.assertLease();
    await this.lock.close();
    await unlink(`${this.path}.lock`);
  }
}

export async function atomicJsonWrite(
  path: string,
  value: unknown,
  testOnlyBeforeDirectorySync?: () => void,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(JSON.stringify(value), "utf8");
    await file.sync();
    await file.close();
    await rename(temp, path);
    const dir = await open(dirname(path), "r");
    try {
      testOnlyBeforeDirectorySync?.();
      await dir.sync();
    } finally {
      await dir.close();
    }
  } catch (error) {
    await file.close().catch(() => undefined);
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}
