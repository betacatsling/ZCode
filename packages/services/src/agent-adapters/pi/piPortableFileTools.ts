import { fork, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReadToolDefinition,
  createEditToolDefinition,
  createWriteToolDefinition,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";

export type PortableTool = NonNullable<CreateAgentSessionOptions["customTools"]>[number];
type Mode = "read" | "edit" | "write";
type Prepared = {
  child?: ChildProcess;
  input: string;
  mode: Mode;
  path: string;
  turnId: string;
  closed: boolean;
  request: (op: string, content?: string) => Promise<unknown>;
  close: () => Promise<void>;
};

/** The worker is the sole owner of prepared operations; the SDK only gets call-ID keyed wrappers. */
export async function createPortablePiBoundary(
  root: string,
  cwd: string,
  activeTurn?: () => string | undefined,
  remote?: (call: {
    callId: string;
    action: "open" | "read" | "write" | "close";
    cwd?: string;
    leaf?: string;
    mode?: Mode;
    rootDev?: string;
    rootIno?: string;
    content?: string;
  }) => Promise<unknown>,
  beforeReadResolver?: (alias: string) => Promise<void>,
) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Pi file tools are not certified on this platform");
  const rootHandle: FileHandle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const rootStat = await rootHandle.stat({ bigint: true });
  const prepared = new Map<string, Prepared>();
  const reviewKey = randomBytes(32);
  let closed = false;
  function absolutePath(raw: unknown) {
    if (typeof raw !== "string" || !raw || raw.includes("\0")) throw new Error("Invalid Pi path");
    const full = resolve(cwd, raw);
    const rel = relative(root, full);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
      throw new Error("Pi file path outside worktree");
    return full;
  }
  async function prepare(id: string, turnId: string, mode: Mode, input: unknown): Promise<void> {
    if (closed || prepared.size >= 8 || prepared.has(id))
      throw new Error("Pi file admission unavailable");
    const encoded = JSON.stringify(input);
    if (typeof encoded !== "string" || Buffer.byteLength(encoded) > 4 * 1024 * 1024)
      throw new Error("Pi input exceeds file tool limit");
    const path = absolutePath((input as { path?: unknown })?.path);
    if (remote) {
      const entry: Prepared = {
        input: encoded,
        path,
        mode,
        turnId,
        closed: false,
        request: (op, content) => remote({ callId: id, action: op as "read" | "write", content }),
        close: async () => {
          if (entry.closed) return;
          entry.closed = true;
          if (prepared.get(id) === entry) prepared.delete(id);
          await remote({ callId: id, action: "close" });
        },
      };
      prepared.set(id, entry);
      try {
        await remote({
          callId: id,
          action: "open",
          cwd: dirname(path),
          leaf: basename(path),
          mode,
          rootDev: rootStat.dev.toString(),
          rootIno: rootStat.ino.toString(),
        });
        if (closed || entry.closed) throw new Error("Pi preparation was cancelled");
      } catch (error) {
        await entry.close();
        throw error;
      }
      return;
    }
    const source = import.meta.url.endsWith(".ts");
    const child = fork(
      fileURLToPath(new URL(source ? "./piFileBroker.ts" : "./piFileBroker.js", import.meta.url)),
      [],
      {
        cwd: dirname(path),
        execPath: process.execPath,
        execArgv: source ? ["--experimental-strip-types"] : [],
        env: {},
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    let counter = 0;
    const waiting = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void }
    >();
    const rejectAll = () => {
      for (const pending of waiting.values()) pending.reject(new Error("Pi broker exited"));
      waiting.clear();
    };
    child.on("message", (raw: unknown) => {
      const response = raw as { id?: number; error?: string; result?: unknown };
      const pending = waiting.get(response?.id ?? -1);
      if (!pending) return;
      waiting.delete(response.id!);
      if (response.error)
        pending.reject(new Error(`Pi broker refused operation: ${response.error}`));
      else pending.resolve(response.result);
    });
    child.on("exit", rejectAll);
    child.on("error", rejectAll);
    const request = (op: string, content?: string) =>
      new Promise<unknown>((resolveRequest, reject) => {
        if (!child.connected) {
          reject(new Error("Pi broker disconnected"));
          return;
        }
        const id = ++counter;
        waiting.set(id, { resolve: resolveRequest, reject });
        child.send(
          {
            id,
            op,
            content,
            ...(op === "init"
              ? {
                  leaf: basename(path),
                  mode,
                  rootDev: rootStat.dev.toString(),
                  rootIno: rootStat.ino.toString(),
                }
              : {}),
          },
          (error) => {
            if (error) {
              waiting.delete(id);
              reject(error);
            }
          },
        );
      });
    const entry: Prepared = {
      child,
      input: encoded,
      path,
      mode,
      turnId,
      closed: false,
      request,
      close: async () => {
        if (entry.closed) return;
        entry.closed = true;
        if (prepared.get(id) === entry) prepared.delete(id);
        if (child.connected) child.send({ id: ++counter, op: "close" });
        // Reap even on an unresponsive child; never leave a detached broker.
        await new Promise<void>((done) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            done();
            return;
          }
          // 修复：单次 SIGTERM 无法证明 broker 退出；升级后仍无退出则报错。
          const term = setTimeout(() => child.kill("SIGTERM"), 250);
          const kill = setTimeout(() => child.kill("SIGKILL"), 750);
          const deadline = setTimeout(() => {
            child.off("exit", onExit);
            done();
          }, 1500);
          const onExit = () => {
            clearTimeout(term);
            clearTimeout(kill);
            clearTimeout(deadline);
            done();
          };
          child.once("exit", onExit);
        });
        if (child.exitCode === null && child.signalCode === null)
          throw new Error("Pi broker did not exit after forced cleanup");
      },
    };
    prepared.set(id, entry);
    try {
      await request("init");
    } catch (error) {
      await entry.close();
      throw error;
    }
  }
  async function release(id: string) {
    await prepared.get(id)?.close();
  }
  async function releaseAll() {
    await Promise.all([...prepared.values()].map((entry) => entry.close()));
  }
  async function close() {
    closed = true;
    try {
      await releaseAll();
    } finally {
      await rootHandle.close();
    }
  }
  function review(id: string) {
    const entry = prepared.get(id);
    if (!entry || entry.closed) throw new Error("Pi approval lacks a prepared operation");
    const target = relative(root, entry.path);
    if (
      !target ||
      target.length > 180 ||
      [...target].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error("Pi file target is not reviewable");
    return {
      mode: entry.mode,
      target,
      bytes: Buffer.byteLength(entry.input),
      digest: createHmac("sha256", reviewKey).update(entry.input).digest("hex").slice(0, 16),
    };
  }
  const tools = (["read", "edit", "write"] as const).map((mode) => {
    const base =
      mode === "read"
        ? createReadToolDefinition(cwd)
        : mode === "edit"
          ? createEditToolDefinition(cwd)
          : createWriteToolDefinition(cwd);
    return {
      ...base,
      // 修复：SDK 默认说明承诺图片附件/自动建父目录，但挂载边界只支持
      // worktree 内现有父目录下 <=4 MiB 的普通文本文件；模型必须在调用前知道限制。
      description:
        mode === "read"
          ? "Read a regular text file (up to 4 MiB) inside the worktree with an existing parent directory. Images are unsupported. Text output follows native offset/limit and truncation rules."
          : mode === "write"
            ? "Create or overwrite a regular text file (up to 4 MiB) inside the worktree. Parent directory must already exist; it will not be created. Requires separate approval before writing."
            : "Edit a regular text file (up to 4 MiB) inside the worktree with an existing parent directory. Each edits[].oldText must uniquely match without overlaps. Requires separate approval.",
      promptGuidelines: [
        ...(base.promptGuidelines ?? []),
        "File tools only support regular text files up to 4 MiB inside the worktree with existing parent directories; images and automatic directory creation are unsupported. Bash is separately approved and is not sandboxed.",
      ],
      execute: async (
        id: string,
        input: never,
        signal: AbortSignal | undefined,
        update: never,
        _ctx: never,
      ) => {
        const entry = prepared.get(id);
        if (
          !entry ||
          entry.mode !== mode ||
          entry.input !== JSON.stringify(input) ||
          (activeTurn && entry.turnId !== activeTurn()) ||
          closed ||
          signal?.aborted
        ) {
          if (entry) await entry.close();
          throw new Error("Pi file operation lacks matching prepared approval");
        }
        const readAlias = `/dev/fd/${rootHandle.fd}`;
        const same = (path: string) => {
          if (path !== (mode === "read" ? readAlias : entry.path))
            throw new Error("Pi SDK changed the prepared path");
        };
        const ops = {
          access: async (path: string) => {
            same(path);
          },
          readFile: async (path: string) => {
            same(path);
            if (signal?.aborted) throw new Error("Operation aborted");
            return Buffer.from((await entry.request("read")) as string, "base64");
          },
          writeFile: async (path: string, content: string) => {
            same(path);
            if (signal?.aborted) throw new Error("Operation aborted");
            await entry.request("write", content);
          },
          mkdir: async (path: string) => {
            if (path !== dirname(entry.path)) throw new Error("New Pi directories are unsupported");
          },
          detectImageMimeType: async (path: string) => {
            same(path);
            const bytes = Buffer.from((await entry.request("read")) as string, "base64");
            if (
              bytes.subarray(0, 4).toString("hex") === "89504e47" ||
              bytes.subarray(0, 3).toString() === "GIF" ||
              bytes.subarray(0, 2).toString("hex") === "ffd8" ||
              (bytes.subarray(0, 4).toString() === "RIFF" &&
                bytes.subarray(8, 12).toString() === "WEBP") ||
              bytes.subarray(0, 2).toString() === "BM"
            )
              throw new Error("Pi image reads are unsupported");
            return null;
          },
        };
        const definition =
          mode === "read"
            ? createReadToolDefinition(cwd, { operations: ops })
            : mode === "edit"
              ? createEditToolDefinition(cwd, { operations: ops })
              : createWriteToolDefinition(cwd, { operations: ops });
        try {
          // 修复：SDK Read 在 operations 之前会按 pathname 探测存在性。
          // 只让它探测本 worker 持有的 root FD，内容仍来自准备时的 broker 文件 FD。
          const sdkInput = mode === "read" ? { ...(input as object), path: readAlias } : input;
          if (mode === "read") await beforeReadResolver?.(readAlias);
          if (closed || signal?.aborted || (activeTurn && entry.turnId !== activeTurn()))
            throw new Error("Pi file operation ended before SDK execution");
          return await definition.execute(id, sdkInput as never, signal, update, { cwd } as never);
        } finally {
          await release(id);
        }
      },
    };
  }) as unknown as PortableTool[];
  return {
    tools,
    prepare,
    release,
    releaseAll,
    close,
    review,
    pendingCount: () => prepared.size,
    brokerPids: () =>
      [...prepared.values()]
        .map((entry) => entry.child?.pid)
        .filter((pid): pid is number => pid !== undefined),
  };
}
