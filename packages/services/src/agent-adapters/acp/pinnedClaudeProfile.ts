import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, realpath, readdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AcpDescriptor } from "./acpTransport.js";

/** Exact published npm 0.16.2 installation tested in isolation; no CLI --version request. */
const PIN = {
  name: "@zed-industries/claude-code-acp",
  version: "0.16.2",
  runtimeSha256: "f59841d0ff58bb9497849fca08b1cf06e5d803da7dce5ff99722e2ba7ec07f87",
} as const;

/** Recognize the pinned profile independently of the caller's asserted `certified` flag. */
export function isPinnedClaudeAcpDescriptor(descriptor: AcpDescriptor): boolean {
  return (
    descriptor.version.exact === PIN.version &&
    descriptor.executable === process.execPath &&
    descriptor.argv.length === 1 &&
    typeof descriptor.argv[0] === "string" &&
    basename(descriptor.argv[0]) === "index.js" &&
    basename(dirname(descriptor.argv[0])) === "dist"
  );
}

/** Verify all shipped runtime JS, not a workspace executable or a non-existent --version flag.
 * Packaging must make this directory immutable after verification (probe-to-spawn race).
 */
export async function probePinnedClaudeAcp(descriptor: AcpDescriptor): Promise<string> {
  const entry = descriptor.argv[0];
  if (
    descriptor.version.exact !== PIN.version ||
    descriptor.version.argv.length !== 0 ||
    descriptor.executable !== process.execPath ||
    descriptor.argv.length !== 1 ||
    !entry ||
    !isAbsolute(entry) ||
    basename(entry) !== "index.js"
  )
    throw new Error("ACP pinned package descriptor mismatch");
  const root = resolve(dirname(entry), "..");
  const dist = join(root, "dist");
  const [actualEntry, actualDist, manifest, filenames] = await Promise.all([
    realpath(entry),
    realpath(dist),
    readFile(join(root, "package.json")),
    readdir(dist),
  ]);
  if (actualEntry !== join(actualDist, "index.js"))
    throw new Error("ACP pinned entrypoint escaped package");
  const parsed: unknown = JSON.parse(manifest.toString("utf8"));
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { name?: unknown }).name !== PIN.name ||
    (parsed as { version?: unknown }).version !== PIN.version
  )
    throw new Error("ACP pinned package identity mismatch");
  const runtimeFiles = filenames.filter((name) => name.endsWith(".js")).sort();
  if (runtimeFiles.length !== 7) throw new Error("ACP pinned runtime file set mismatch");
  const digest = createHash("sha256");
  for (const name of runtimeFiles) {
    const path = join(dist, name);
    if ((await realpath(path)) !== join(actualDist, name))
      throw new Error("ACP pinned runtime symlink rejected");
    digest
      .update(name)
      .update(Buffer.from([0]))
      .update(await readFile(path));
  }
  if (!timingSafeEqual(digest.digest(), Buffer.from(PIN.runtimeSha256, "hex")))
    throw new Error("ACP pinned package byte digest mismatch");
  return PIN.version;
}
