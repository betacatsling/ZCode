import { fork, type ChildProcess } from "node:child_process";
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
  child: ChildProcess;
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
) {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw new Error("Pi file tools are not certified on this platform");
  const rootHandle: FileHandle = await open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  const rootStat = await rootHandle.stat({ bigint: true });
  const prepared = new Map<string, Prepared>();
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
          const timeout = setTimeout(() => child.kill(), 500);
          timeout.unref();
          child.once("exit", () => {
            clearTimeout(timeout);
            done();
          });
        });
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
    await releaseAll();
    await rootHandle.close();
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
        const same = (path: string) => {
          if (path !== entry.path) throw new Error("Pi SDK changed the prepared path");
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
          return await definition.execute(id, input, signal, update, { cwd } as never);
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
    pendingCount: () => prepared.size,
    brokerPids: () =>
      [...prepared.values()]
        .map((entry) => entry.child.pid)
        .filter((pid): pid is number => pid !== undefined),
  };
}
