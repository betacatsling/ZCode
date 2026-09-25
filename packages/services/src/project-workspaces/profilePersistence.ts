import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";
import { getProcessOwnerEpoch } from "./ownerEpoch.js";

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
      // 中文：恢复标记序列化重启者；旧 PID 必须已退出，未知格式一律拒绝。
      const recovery = await open(`${path}.recovery`, "wx", 0o600);
      try {
        const previous = await readFile(`${path}.lock`, "utf8").catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (previous !== undefined) {
          const parsed: unknown = JSON.parse(previous);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            typeof (parsed as { token?: unknown }).token !== "string" ||
            !Number.isSafeInteger((parsed as { pid?: unknown }).pid) ||
            (parsed as { pid: number }).pid <= 0
          )
            throw new Error("unknown-profile-owner");
          try {
            process.kill((parsed as { pid: number }).pid, 0);
            throw new Error("profile-owner-still-running");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
          }
          if ((await readFile(`${path}.lock`, "utf8")) !== previous)
            throw new Error("profile-owner-fence-lost");
          await unlink(`${path}.lock`);
        }
        return await this.create(path);
      } finally {
        await recovery.close();
        await unlink(`${path}.recovery`);
      }
    }
    return this.create(path);
  }

  private static async create(path: string): Promise<ProfileFileOwner> {
    const lock = await open(`${path}.lock`, "wx", 0o600);
    const token = randomUUID();
    try {
      // ownerEpoch 绑定本进程本次化身；可信 Supervisor 只认它与私有 IPC 申报一致且已收割
      // 的记录，PID 复用、旧格式（无 epoch）或外来记录一律 fail closed。
      // 见 docs/specs/core-occupancy-recovery.md。
      await lock.writeFile(
        JSON.stringify({ token, pid: process.pid, ownerEpoch: getProcessOwnerEpoch() }),
        "utf8",
      );
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

export async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
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
