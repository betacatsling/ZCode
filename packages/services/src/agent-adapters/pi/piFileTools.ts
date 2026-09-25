import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Linux descriptor-relative backend. No pathname check is used as authority for IO. */
export type PiFileTool = NonNullable<CreateAgentSessionOptions["customTools"]>[number];

export async function createPiFileTools(
  root: string,
  hooks?: { afterOpen?: (path: string, mode: "read" | "edit" | "write") => Promise<void> },
): Promise<PiFileTool[]> {
  if (process.platform !== "linux")
    throw new Error("Pi file tools require Linux descriptor-relative IO");
  const anchored = resolve(root);
  const initial = await open(anchored, dirFlags);
  let identity: { dev: bigint; ino: bigint };
  try {
    const stat = await initial.stat({ bigint: true });
    if (!stat.isDirectory()) throw new Error("Pi worktree root is not a directory");
    identity = { dev: stat.dev, ino: stat.ino };
    // Fail closed if /proc is unavailable (including restricted containers).
    // /proc/self/fd/N itself is a magic link; final O_NOFOLLOW must target ".".
    const probe = await open(`/proc/self/fd/${initial.fd}/.`, dirFlags);
    await probe.close();
  } finally {
    await initial.close();
  }

  async function parentFor(path: string): Promise<{ parent: FileHandle; leaf: string }> {
    if (!isAbsolute(path) || path.includes("\0")) throw new Error("Invalid Pi file path");
    const rel = relative(anchored, resolve(path));
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Pi file path outside worktree");
    const parts = rel.split(sep);
    let parent = await open(anchored, dirFlags);
    try {
      const stat = await parent.stat({ bigint: true });
      if (stat.dev !== identity.dev || stat.ino !== identity.ino)
        throw new Error("Pi worktree root changed");
      for (const part of parts.slice(0, -1)) {
        // 根因：审批时验证的 pathname 可被换成软链；逐级基于已打开目录 fd 查找，
        // 即使审批后或工具执行中路径被替换，也不会跟随到 worktree 外。
        const next = await open(`/proc/self/fd/${parent.fd}/${part}`, dirFlags);
        await parent.close();
        parent = next;
      }
      return { parent, leaf: parts.at(-1)! };
    } catch (error) {
      await parent.close();
      throw error;
    }
  }

  async function file(path: string, mode: "read" | "edit" | "write"): Promise<FileHandle> {
    const { parent, leaf } = await parentFor(path);
    try {
      const flags =
        (mode === "read" ? constants.O_RDONLY : constants.O_RDWR) |
        fileFlags |
        (mode === "write" ? constants.O_CREAT : 0);
      const handle = await open(`/proc/self/fd/${parent.fd}/${leaf}`, flags, 0o666);
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        throw new Error("Pi file tool requires a regular file");
      }
      return handle;
    } finally {
      await parent.close();
    }
  }

  async function writeOpened(handle: FileHandle, content: string): Promise<void> {
    const bytes = Buffer.from(content, "utf8");
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
      if (!bytesWritten) throw new Error("Pi file write made no progress");
      offset += bytesWritten;
    }
    await handle.truncate(bytes.length);
  }

  // SDK 默认 access/read/write 重新按路径打开会产生检查到使用间的竞态；
  // 单次调用复用同一 fd，避免路径被 rename/软链替换后读写另一文件。
  function operations(handle: FileHandle | undefined, expected: string, signal?: AbortSignal) {
    const same = (path: string) => {
      if (resolve(path) !== expected) throw new Error("Pi SDK changed the approved file path");
    };
    return {
      access: async (path: string) => {
        same(path);
      },
      readFile: async (path: string) => {
        same(path);
        if (!handle) throw new Error("Pi read requires an existing file");
        return handle.readFile();
      },
      writeFile: async (path: string, content: string) => {
        same(path);
        if (signal?.aborted) throw new Error("Operation aborted");
        // 新文件只在 SDK 真正写入时创建；预先创建会让取消的工具留下副作用。
        const target = handle ?? (await file(expected, "write"));
        try {
          await writeOpened(target, content);
        } finally {
          if (!handle) await target.close();
        }
      },
      detectImageMimeType: async (path: string) => {
        same(path);
        // No alternate pathname-based image sniffing. Images are not certified by this backend.
        const bytes = Buffer.alloc(12);
        if (!handle) throw new Error("Pi read requires an existing file");
        await handle.read(bytes, 0, bytes.length, 0);
        if (
          bytes.subarray(0, 4).toString("hex") === "89504e47" ||
          bytes.subarray(0, 3).toString() === "GIF" ||
          bytes.subarray(0, 2).toString("hex") === "ffd8" ||
          (bytes.subarray(0, 4).toString() === "RIFF" &&
            bytes.subarray(8, 12).toString() === "WEBP") ||
          bytes.subarray(0, 2).toString() === "BM"
        )
          throw new Error("Pi image reads are not certified by the file boundary");
        return null;
      },
      mkdir: async (dir: string) => {
        // SDK write attempts mkdir before write; only existing directories are supported.
        const { parent, leaf } = await parentFor(resolve(dir, ".pi-parent-probe"));
        await parent.close();
        if (leaf !== ".pi-parent-probe") throw new Error("Invalid Pi directory probe");
      },
    };
  }

  async function run<T>(
    path: string,
    cwd: string,
    mode: "read" | "edit" | "write",
    signal: AbortSignal | undefined,
    invoke: (ops: ReturnType<typeof operations>) => Promise<T>,
  ): Promise<T> {
    // SDK ctx.cwd is not authority. Tool paths are relative to the frozen Pi session cwd.
    const absolute = resolve(cwd, path);
    if (signal?.aborted) throw new Error("Operation aborted");
    const handle =
      mode === "write"
        ? await file(absolute, "edit").catch((error: unknown) => {
            if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
              return undefined;
            throw error;
          })
        : await file(absolute, mode);
    try {
      if (handle) await hooks?.afterOpen?.(absolute, mode);
      return await invoke(operations(handle, absolute, signal));
    } finally {
      await handle?.close();
    }
  }

  const read = createReadToolDefinition(root);
  const edit = createEditToolDefinition(root);
  const write = createWriteToolDefinition(root);
  return [
    {
      ...read,
      execute: (
        id: string,
        input: Parameters<typeof read.execute>[1],
        signal: AbortSignal | undefined,
        update: Parameters<typeof read.execute>[3],
        ctx: Parameters<typeof read.execute>[4],
      ) =>
        run(input.path, ctx?.cwd || root, "read", signal, (ops) =>
          createReadToolDefinition(root, { operations: ops }).execute(
            id,
            input,
            signal,
            update,
            ctx,
          ),
        ),
    },
    {
      ...edit,
      execute: (
        id: string,
        input: Parameters<typeof edit.execute>[1],
        signal: AbortSignal | undefined,
        update: Parameters<typeof edit.execute>[3],
        ctx: Parameters<typeof edit.execute>[4],
      ) =>
        run(input.path, ctx?.cwd || root, "edit", signal, (ops) =>
          createEditToolDefinition(root, { operations: ops }).execute(
            id,
            input,
            signal,
            update,
            ctx,
          ),
        ),
    },
    {
      ...write,
      execute: (
        id: string,
        input: Parameters<typeof write.execute>[1],
        signal: AbortSignal | undefined,
        update: Parameters<typeof write.execute>[3],
        ctx: Parameters<typeof write.execute>[4],
      ) =>
        run(input.path, ctx?.cwd || root, "write", signal, (ops) =>
          createWriteToolDefinition(root, { operations: ops }).execute(
            id,
            input,
            signal,
            update,
            ctx,
          ),
        ),
    },
  ] as unknown as PiFileTool[];
}
