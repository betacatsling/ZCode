import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

export interface OwnerLease {
  readonly fence: number;
  readonly generation: number;
  assertCurrent(): Promise<void>;
  release(): Promise<void>;
}

interface FenceFile {
  schemaVersion: 1;
  targetId: string;
  hostSessionId: string;
  fence: number;
  pid: number;
  generation: number;
  ownerToken: string;
}

export function ownerFencePath(root: string, targetId: string, hostSessionId: string): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([targetId, hostSessionId]))
    .digest("hex");
  return join(root, "owner-fences", `${digest}.json`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readFence(path: string): Promise<FenceFile> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("runtime-host-fence-corrupt");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as FenceFile).schemaVersion !== 1 ||
    typeof (parsed as FenceFile).targetId !== "string" ||
    typeof (parsed as FenceFile).hostSessionId !== "string" ||
    typeof (parsed as FenceFile).ownerToken !== "string" ||
    !Number.isInteger((parsed as FenceFile).fence) ||
    !Number.isInteger((parsed as FenceFile).pid) ||
    !Number.isInteger((parsed as FenceFile).generation)
  ) {
    throw new Error("runtime-host-fence-corrupt");
  }
  return parsed as FenceFile;
}

async function writeFence(handle: FileHandle, record: FenceFile): Promise<void> {
  const payload = Buffer.from(JSON.stringify(record));
  await handle.truncate(0);
  await handle.write(payload, 0, payload.length, 0);
  await handle.sync();
}

class FileOwnerLease implements OwnerLease {
  constructor(
    readonly fence: number,
    readonly generation: number,
    private readonly path: string,
    private readonly record: FenceFile,
    private handle: FileHandle | undefined,
  ) {}

  async assertCurrent(): Promise<void> {
    const current = await readFence(this.path);
    if (
      current.fence !== this.record.fence ||
      current.ownerToken !== this.record.ownerToken ||
      current.pid !== this.record.pid ||
      current.generation !== this.record.generation ||
      current.targetId !== this.record.targetId ||
      current.hostSessionId !== this.record.hostSessionId
    ) {
      throw new Error("runtime-host-stale-fence");
    }
  }

  async release(): Promise<void> {
    await this.assertCurrent();
    await this.handle?.close();
    this.handle = undefined;
    await unlink(this.path);
  }
}

export async function reserveOwnerLease(input: {
  root: string;
  targetId: string;
  hostSessionId: string;
  generation: number;
  ownerToken: string;
}): Promise<OwnerLease> {
  if (!Number.isInteger(input.generation) || input.generation < 1) {
    throw new Error("runtime-host-identity-mismatch");
  }
  const path = ownerFencePath(input.root, input.targetId, input.hostSessionId);
  await mkdir(join(input.root, "owner-fences"), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = await open(path, "wx", 0o600);
      const record: FenceFile = {
        schemaVersion: 1,
        targetId: input.targetId,
        hostSessionId: input.hostSessionId,
        fence: 1,
        pid: process.pid,
        generation: input.generation,
        ownerToken: input.ownerToken,
      };
      await writeFence(handle, record);
      return new FileOwnerLease(record.fence, record.generation, path, record, handle);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const current = await readFence(path);
    if (current.targetId !== input.targetId || current.hostSessionId !== input.hostSessionId) {
      throw new Error("runtime-host-identity-mismatch");
    }
    if (isPidAlive(current.pid)) {
      // 活着的 owner 即使 generation 更旧也不能被抢走；第二个 Core 必须失败关闭。
      throw new Error("runtime-host-live-owner: runtime host already has a live owner");
    }
    try {
      await rename(path, `${path}.dead.${current.fence}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const handle = await open(path, "wx", 0o600);
    const record: FenceFile = {
      schemaVersion: 1,
      targetId: input.targetId,
      hostSessionId: input.hostSessionId,
      fence: current.fence + 1,
      pid: process.pid,
      generation: input.generation,
      ownerToken: input.ownerToken,
    };
    await writeFence(handle, record);
    return new FileOwnerLease(record.fence, record.generation, path, record, handle);
  }
  throw new Error("runtime-host-live-owner: runtime host already has a live owner");
}

export async function runUnderOwnerFence<T>(
  gate: {
    hold(hostSessionId: string): Promise<{ acquired: boolean }>;
    rollback(hostSessionId: string): Promise<void>;
  },
  hostSessionId: string,
  isMounted: () => boolean,
  operation: () => Promise<T>,
): Promise<T> {
  const reservation = await gate.hold(hostSessionId);
  try {
    return await operation();
  } catch (error) {
    // 未挂上 host 的失败预留必须放开，否则同进程下一次 create 会被自己挡住。
    if (reservation.acquired && !isMounted()) await gate.rollback(hostSessionId);
    throw error;
  }
}

export function createTargetOwnerGate(options: {
  root: string;
  targetId: string;
  generation: number;
}): {
  hold(hostSessionId: string): Promise<{ acquired: boolean }>;
  assertIfHeld(hostSessionId: string): Promise<void>;
  rollback(hostSessionId: string): Promise<void>;
  releaseAll(): Promise<void>;
} {
  const ownerToken = randomUUID();
  const held = new Map<string, OwnerLease>();
  return {
    async hold(hostSessionId) {
      const existing = held.get(hostSessionId);
      if (existing) {
        await existing.assertCurrent();
        return { acquired: false };
      }
      const lease = await reserveOwnerLease({ ...options, hostSessionId, ownerToken });
      held.set(hostSessionId, lease);
      return { acquired: true };
    },
    async assertIfHeld(hostSessionId) {
      const existing = held.get(hostSessionId);
      if (!existing) return;
      await existing.assertCurrent();
    },
    async rollback(hostSessionId) {
      const existing = held.get(hostSessionId);
      if (!existing) return;
      held.delete(hostSessionId);
      await existing.release();
    },
    async releaseAll() {
      const leases = [...held.values()];
      held.clear();
      for (const lease of leases) await lease.release();
    },
  };
}
