/* Isolated single-file broker. This module is launched only by the Pi worker (not imported). */
import { constants } from "node:fs";
import { open, lstat, type FileHandle } from "node:fs/promises";
import { basename, sep } from "node:path";

const flags = constants.O_NOFOLLOW | constants.O_NONBLOCK;
const maxBytes = 4 * 1024 * 1024;
let file: FileHandle | undefined;
let leaf = "";
let mode: "read" | "edit" | "write";
let absent = false;
let ready = false;
let busy = false;

function fail(id: number, error: unknown): void {
  const code = error instanceof Error && "code" in error ? String(error.code) : "REFUSED";
  process.send?.({ id, error: code });
}
async function close(): Promise<void> {
  ready = false;
  await file?.close();
  file = undefined;
  process.disconnect?.();
}
async function init(raw: {
  leaf: string;
  mode: typeof mode;
  rootDev: string;
  rootIno: string;
}): Promise<void> {
  if (
    !raw ||
    typeof raw.leaf !== "string" ||
    raw.leaf === "." ||
    raw.leaf === ".." ||
    raw.leaf.includes("\0") ||
    raw.leaf.includes("/") ||
    raw.leaf.includes("\\") ||
    basename(raw.leaf) !== raw.leaf ||
    !["read", "edit", "write"].includes(raw.mode)
  )
    throw new Error("Invalid broker input");
  leaf = raw.leaf;
  mode = raw.mode;
  // The process cwd is a kernel-held directory, not an authorization by pathname.
  // '..' resolves actual ancestor directory entries, never a symlink on the input path.
  let found = false;
  for (let depth = 0; depth < 256; depth++) {
    const candidate = depth ? Array(depth).fill("..").join(sep) : ".";
    const dir = await open(candidate, constants.O_RDONLY | constants.O_DIRECTORY | flags);
    try {
      const stat = await dir.stat({ bigint: true });
      if (stat.dev.toString() === raw.rootDev && stat.ino.toString() === raw.rootIno) {
        found = true;
        break;
      }
      const parent = await open(
        `${candidate}${sep}..`,
        constants.O_RDONLY | constants.O_DIRECTORY | flags,
      );
      try {
        const above = await parent.stat({ bigint: true });
        if (stat.dev === above.dev && stat.ino === above.ino) break;
      } finally {
        await parent.close();
      }
    } finally {
      await dir.close();
    }
  }
  if (!found) throw new Error("Parent not owned by worktree");
  try {
    // 修复：SDK Write 使用 fsWriteFile (仅需写权限)；预备阶段不能以 O_RDWR
    // 错拒 0200 文件，也不能提前 O_TRUNC。Edit 仍需同一 FD 读写。
    file = await open(
      leaf,
      (mode === "read"
        ? constants.O_RDONLY
        : mode === "write"
          ? constants.O_WRONLY
          : constants.O_RDWR) | flags,
    );
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("Nonregular or oversized Pi file");
  } catch (error) {
    await file?.close();
    file = undefined;
    if (
      mode !== "write" ||
      !(error && typeof error === "object" && "code" in error && error.code === "ENOENT")
    )
      throw error;
    // No creation before permission. O_EXCL on effect prevents substituted leaf adoption.
    await lstat(leaf).then(
      () => {
        throw new Error("Leaf appeared during preparation");
      },
      (err: unknown) => {
        if (!(err && typeof err === "object" && "code" in err && err.code === "ENOENT")) throw err;
      },
    );
    absent = true;
  }
  ready = true;
}
async function operation(raw: { op: string; content?: string }): Promise<unknown> {
  if (raw.op === "read") {
    if (!file) throw new Error("Missing file");
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("File no longer regular or exceeds limit");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset).toString("base64");
  }
  if (
    raw.op !== "write" ||
    mode === "read" ||
    typeof raw.content !== "string" ||
    Buffer.byteLength(raw.content, "utf8") > maxBytes
  )
    throw new Error("Invalid broker operation");
  if (absent) {
    file = await open(
      leaf,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | flags,
      0o666,
    );
    absent = false;
  }
  const stat = await file!.stat();
  if (!stat.isFile()) throw new Error("Target is no longer regular");
  const bytes = Buffer.from(raw.content, "utf8");
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file!.write(bytes, offset, bytes.length - offset, offset);
    if (!bytesWritten) throw new Error("No write progress");
    offset += bytesWritten;
  }
  await file!.truncate(bytes.length);
  return null;
}
process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object" || !("id" in raw) || !Number.isSafeInteger(raw.id) || busy) {
    void close();
    return;
  }
  const message = raw as {
    id: number;
    op: string;
    leaf: string;
    mode: typeof mode;
    rootDev: string;
    rootIno: string;
    content?: string;
  };
  if (message.op === "close") {
    void close();
    return;
  }
  busy = true;
  void (async () => {
    try {
      const result =
        !ready && message.op === "init"
          ? await init(message)
          : ready
            ? await operation(message)
            : undefined;
      if (result === undefined && !ready) throw new Error("Broker not ready");
      process.send?.({ id: message.id, result: result ?? null });
    } catch (error) {
      fail(message.id, error);
    } finally {
      busy = false;
    }
  })();
});
process.on("disconnect", () => {
  // 修复：worker 被意外终止时已无父进程可回收 broker；IPC 断开后
  // 禁止继续接受 IO，并限时退出，避免异步文件句柄使子进程永久存活。
  ready = false;
  void file?.close().catch(() => {});
  setTimeout(() => process.exit(1), 1000);
});
