import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { withFileLock } from "@zcode/shared/node";
import { isErrno, ProjectWorkspaceError } from "./errors.js";
import type { CatalogStore } from "./ports.js";
import { assertSnapshot, cloneSnapshot, emptySnapshot, type CatalogSnapshot } from "./snapshot.js";

export function createMemoryCatalogStore(initial?: CatalogSnapshot): CatalogStore {
  let current = cloneSnapshot(initial ?? emptySnapshot());
  let queue: Promise<unknown> = Promise.resolve();
  return {
    async read() {
      await queue;
      return cloneSnapshot(current);
    },
    update(mutator) {
      const run = queue.then(async () => {
        const outcome = mutator(cloneSnapshot(current));
        assertSnapshot(outcome.snapshot);
        current = cloneSnapshot(outcome.snapshot);
        return outcome.result;
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

async function readCatalogFile(filePath: string): Promise<CatalogSnapshot> {
  let text: string;
  try {
    text = await readFile(filePath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) return emptySnapshot();
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new ProjectWorkspaceError("unsupported-schema");
  }
  const snapshot = parsed as CatalogSnapshot;
  // 旧目录没有活动摘要时补空对象，避免把缺省读成“已全部完成”。
  if (!snapshot.sessionActivityById || typeof snapshot.sessionActivityById !== "object") {
    snapshot.sessionActivityById = {};
  }
  assertSnapshot(snapshot);
  return snapshot;
}

export function createFileCatalogStore(filePath: string): CatalogStore {
  const lockPath = `${filePath}.lock`;
  return {
    read: () => withFileLock(lockPath, () => readCatalogFile(filePath)),
    update: (mutator) =>
      withFileLock(lockPath, async () => {
        const outcome = mutator(cloneSnapshot(await readCatalogFile(filePath)));
        assertSnapshot(outcome.snapshot);
        const directory = dirname(filePath);
        await mkdir(directory, { recursive: true });
        const tempPath = join(directory, `.${basename(filePath)}.${process.pid}.tmp`);
        await writeFile(tempPath, JSON.stringify(outcome.snapshot), "utf8");
        await rename(tempPath, filePath);
        return outcome.result;
      }),
  };
}
