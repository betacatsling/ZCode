import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Private Git admin-directory marker prevents inode reuse from reviving a removed worktree. */
export class TargetInstanceMarker {
  private readonly prefix: string;
  constructor(targetId: string) {
    this.prefix = `.zcode-target-${createHash("sha256").update(targetId).digest("hex")}`;
  }
  private file(adminPath: string, kind: "binding" | "workspace"): string {
    return path.join(adminPath, `${this.prefix}.${kind}`);
  }
  async matches(
    adminPath: string,
    kind: "binding" | "workspace",
    expected: string,
  ): Promise<boolean> {
    try {
      return (await readFile(this.file(adminPath, kind), "utf8")) === expected;
    } catch {
      return false;
    }
  }
  async assign(adminPath: string, kind: "binding" | "workspace"): Promise<string> {
    const marker = randomUUID();
    const file = this.file(adminPath, kind);
    try {
      await writeFile(file, marker, { flag: "wx", mode: 0o600 });
      return marker;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await readFile(file, "utf8");
      if (!/^[0-9a-f-]{36}$/.test(existing)) throw new Error("Invalid target instance marker");
      return existing;
    }
  }
}
