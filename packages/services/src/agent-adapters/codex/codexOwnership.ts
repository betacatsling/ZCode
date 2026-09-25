import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  backendBindingV2Schema,
  writableSessionSpecV2Schema,
  type BackendBindingV2,
  type SessionSpecV2,
} from "@zcode/shared/agent-host";

export type NativeOwnership = {
  version: 1;
  binding: BackendBindingV2;
  spec: SessionSpecV2;
  cwd: string;
  state: "never-started" | "starting" | "established";
  threadId?: string;
};
const pathFor = (profile: string, binding: BackendBindingV2) =>
  join(profile, `${binding.backendSessionId}.ownership.json`);
const markerFor = (profile: string, binding: BackendBindingV2) =>
  join(profile, `${binding.backendSessionId}.thread`);

/** Atomic replace + file and parent-directory sync: acknowledgement must follow durable state. */
async function persist(path: string, value: string): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temp, path);
  const directory = await open(join(path, ".."), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function createNativeOwnership(
  profile: string,
  binding: BackendBindingV2,
  spec: SessionSpecV2,
  cwd: string,
): Promise<NativeOwnership> {
  // 修复原因：已有目录可能是遗失的原生上下文，不得将它初始化成新 draft。
  try {
    await mkdir(profile, { mode: 0o700 });
  } catch (error) {
    // 修复：独占目录冲突代表可能遗失的 Host 创建收据；只转换错误，不碰原记录/marker。
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("Codex native ownership unknown; history only", { cause: error });
    throw error;
  }
  const ownership: NativeOwnership = { version: 1, binding, spec, cwd, state: "never-started" };
  if (Buffer.byteLength(JSON.stringify(ownership)) > 16_384)
    throw new Error("Codex native ownership scope too large");
  await persist(pathFor(profile, binding), JSON.stringify(ownership));
  return ownership;
}

async function regularFile(path: string): Promise<string> {
  const file = await lstat(path);
  if (!file.isFile() || file.size > 16_384) throw new Error("Codex native ownership unknown");
  const value = await readFile(path, "utf8");
  if (Buffer.byteLength(value) > 16_384) throw new Error("Codex native ownership unknown");
  return value;
}

export async function readNativeOwnership(
  profile: string,
  binding: BackendBindingV2,
  spec: SessionSpecV2,
  cwd: string,
): Promise<NativeOwnership> {
  try {
    const raw = await regularFile(pathFor(profile, binding));
    if (Buffer.byteLength(raw) > 16_384) throw new Error("oversized native ownership");
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") throw new Error("invalid native ownership");
    const ownership = value as NativeOwnership;
    if (
      ownership.version !== 1 ||
      JSON.stringify(backendBindingV2Schema.parse(ownership.binding)) !==
        JSON.stringify(backendBindingV2Schema.parse(binding)) ||
      JSON.stringify(writableSessionSpecV2Schema.parse(ownership.spec)) !==
        JSON.stringify(writableSessionSpecV2Schema.parse(spec)) ||
      ownership.cwd !== cwd
    )
      throw new Error("native ownership scope mismatch");
    if (ownership.state === "established") {
      if (
        !ownership.threadId ||
        (await regularFile(markerFor(profile, binding))) !== ownership.threadId
      )
        throw new Error("lost native thread marker");
    } else if (ownership.state === "never-started" && ownership.threadId === undefined) {
      // A marker with a never-started record means an interrupted transition, not a clean draft.
      try {
        await lstat(markerFor(profile, binding));
        throw new Error("unexpected native thread marker");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } else throw new Error("ambiguous native ownership");
    return ownership;
  } catch {
    // 修复依据：缺文件、写入中断、旧版或状态不一致都不能推断从未启动；保留 Host 只读历史。
    throw new Error("Codex native ownership unknown; history only");
  }
}

export async function advanceNativeOwnership(
  profile: string,
  current: NativeOwnership,
  next: "starting" | "established",
  threadId?: string,
): Promise<NativeOwnership> {
  if (
    (next === "starting" && current.state !== "never-started") ||
    (next === "established" &&
      (current.state !== "starting" || !threadId || Buffer.byteLength(threadId) > 4096))
  )
    throw new Error("Codex native ownership transition invalid");
  const updated: NativeOwnership = { ...current, state: next, ...(threadId ? { threadId } : {}) };
  if (next === "established") await persist(markerFor(profile, current.binding), threadId!);
  await persist(pathFor(profile, current.binding), JSON.stringify(updated));
  return updated;
}
