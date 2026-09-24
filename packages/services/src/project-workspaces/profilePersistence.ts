import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

/** Lock stealing is deliberately forbidden: after a crash recovery requires operator inspection. */
export class ProfileFileOwner {
  private constructor(
    readonly path: string,
    private readonly lock: FileHandle,
    private readonly token: string,
  ) {}

  static async open(path: string): Promise<ProfileFileOwner> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lock = await open(`${path}.lock`, "wx", 0o600);
    const token = randomUUID();
    try {
      await lock.writeFile(token, "utf8");
      await lock.sync();
      return new ProfileFileOwner(path, lock, token);
    } catch (error) {
      await lock.close();
      await unlink(`${path}.lock`);
      throw error;
    }
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
    if ((await readFile(`${this.path}.lock`, "utf8")) !== this.token)
      throw new Error("profile-owner-fence-lost");
    await atomicJsonWrite(this.path, value);
  }

  async remove(): Promise<void> {
    if ((await readFile(`${this.path}.lock`, "utf8")) !== this.token)
      throw new Error("profile-owner-fence-lost");
    await unlink(this.path);
  }

  async close(): Promise<void> {
    if ((await readFile(`${this.path}.lock`, "utf8")) !== this.token)
      throw new Error("profile-owner-fence-lost");
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
