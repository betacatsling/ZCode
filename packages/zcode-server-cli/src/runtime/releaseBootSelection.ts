import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, win32 } from "node:path";
import { z } from "zod";
import type { ReleaseManifest } from "../contracts.js";
import { hashReleaseTree } from "./immutableRelease.js";
import type { ServerLayout } from "./paths.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/u);
const artifacts = z
  .object({
    "server-cli.js": hex,
    "server-core.js": hex,
    "zcode.cjs": hex,
    node: hex,
    "piWorker.js": hex,
  })
  .strict();
const selectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    provenance: z.literal("trusted-local-source-only"),
    protocol: z.literal("constructor-held-native-v1"),
    sourceRecipe: z.string().min(1),
    version: z.string().min(1),
    target: z.string().min(1),
    releaseId: z.string().min(1),
    archiveSha256: hex,
    releaseContentSha256: hex,
    artifactSha256: artifacts,
    componentSha256: z.record(z.string().min(1), hex),
  })
  .strict();
const selectionsSchema = z.array(selectionSchema);
export type TrustedLocalSourceBootSelection = z.infer<typeof selectionSchema>;
export type LocalSourceBootEvidence = Pick<
  TrustedLocalSourceBootSelection,
  "protocol" | "sourceRecipe" | "releaseContentSha256" | "artifactSha256" | "componentSha256"
>;

const selectionPath = (layout: ServerLayout): string =>
  join(layout.serverRoot, "trusted-local-boot-selections.json");

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function readSelections(layout: ServerLayout): Promise<TrustedLocalSourceBootSelection[]> {
  let source: string;
  try {
    source = await readFile(selectionPath(layout), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return selectionsSchema.parse(JSON.parse(source));
}

export function isInstalledReleaseOffset(offset: string): boolean {
  // 中文：Windows 不同盘的 relative() 可以返回绝对 D:\\...，仅检查 .. 会把
  // 越界 release 错误地当成已安装可信产物；同时覆盖 POSIX 与 Windows 路径语法。
  return Boolean(
    offset &&
    !isAbsolute(offset) &&
    !win32.isAbsolute(offset) &&
    offset !== ".." &&
    !offset.startsWith("../") &&
    !offset.startsWith("..\\"),
  );
}

async function verifyContent(
  layout: ServerLayout,
  release: ReleaseManifest,
  selection: TrustedLocalSourceBootSelection,
): Promise<void> {
  const directory = await realpath(release.releaseDir);
  const root = await realpath(layout.releasesDir);
  const offset = relative(root, directory);
  if (!isInstalledReleaseOffset(offset))
    throw new Error("Boot selection release escaped installed releases directory");
  const expected = selectionSchema.parse(selection);
  if (
    release.releaseId !== expected.releaseId ||
    release.archiveSha256 !== expected.archiveSha256 ||
    release.version !== expected.version ||
    release.target !== expected.target
  )
    throw new Error("Boot selection identity mismatch");
  const components = release.components ?? [];
  if (
    components.length !== Object.keys(expected.componentSha256).length ||
    components.some((item) => expected.componentSha256[item.id] !== item.sha256)
  )
    throw new Error("Boot selection component mismatch");
  const integrity = JSON.parse(
    await readFile(join(directory, ".release-integrity.json"), "utf8"),
  ) as {
    archiveSha256?: string;
    contentSha256?: string;
    target?: string;
    version?: string;
  };
  if (
    integrity.archiveSha256 !== expected.archiveSha256 ||
    integrity.contentSha256 !== expected.releaseContentSha256 ||
    integrity.target !== expected.target ||
    integrity.version !== expected.version ||
    (await hashReleaseTree(directory)) !== expected.releaseContentSha256
  )
    throw new Error("Boot selection installed tree mismatch");
  const runtime = join(directory, "runtime");
  for (const [name, digest] of Object.entries(expected.artifactSha256)) {
    const installedName = name === "node" && process.platform === "win32" ? "node.exe" : name;
    if ((await sha256(join(runtime, installedName))) !== digest)
      throw new Error(`Boot selection installed artifact mismatch: ${name}`);
  }
}

/**
 * A trusted CURRENT-SOURCE staging/test actor alone calls this after an executable disposable
 * held-claim/denied-effect/exact-release probe. Do not call it on downloaded or legacy binaries.
 * The record is outside the archive; its digests are tied to immutable installed bytes, not a
 * self-declared manifest capability. This local mechanism is NOT a publisher signature.
 */
export async function registerTrustedLocalSourceBootSelection(
  layout: ServerLayout,
  release: ReleaseManifest,
  evidence: LocalSourceBootEvidence,
): Promise<void> {
  const selection = selectionSchema.parse({
    ...evidence,
    schemaVersion: 1,
    provenance: "trusted-local-source-only",
    releaseId: release.releaseId,
    version: release.version,
    target: release.target,
    archiveSha256: release.archiveSha256,
  });
  await verifyContent(layout, release, selection);
  const existing = await readSelections(layout);
  const selections = [
    ...existing.filter((entry) => entry.releaseId !== selection.releaseId),
    selection,
  ];
  const output = selectionPath(layout);
  await mkdir(layout.serverRoot, { recursive: true, mode: 0o700 });
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(selections, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/** Run before changing a healthy owner, and again immediately before a held launch. */
export async function verifyTrustedLocalSourceBootSelection(
  layout: ServerLayout,
  release: ReleaseManifest,
): Promise<TrustedLocalSourceBootSelection> {
  const entries = await readSelections(layout);
  const selection = entries.find((entry) => entry.releaseId === release.releaseId);
  if (!selection) throw new Error("Trusted local boot selection missing for installed release");
  await verifyContent(layout, release, selection);
  return selection;
}
