import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { ServerLayout } from "./paths.js";

const SERVER_INSTALL_OWNERSHIP_PRODUCT = "zcode-server";
const SERVER_INSTALL_OWNERSHIP_SCHEMA_VERSION = 1;

const serverInstallOwnershipSchema = z
  .object({
    product: z.literal(SERVER_INSTALL_OWNERSHIP_PRODUCT),
    schemaVersion: z.literal(SERVER_INSTALL_OWNERSHIP_SCHEMA_VERSION),
    canonicalServerRoot: z.string().min(1),
    installationId: z.string().uuid(),
    targetId: z
      .string()
      .min(1)
      .max(256)
      .refine((value) => value === value.trim())
      .optional(),
    installedAt: z.number().int().nonnegative(),
  })
  .strict();

type ServerInstallOwnership = z.infer<typeof serverInstallOwnershipSchema>;

async function readOwnership(layout: ServerLayout): Promise<ServerInstallOwnership> {
  const markerStat = await lstat(layout.installFile).catch(() => null);
  if (!markerStat?.isFile()) {
    throw new Error(`ZCode Server ownership marker is missing or invalid: ${layout.installFile}`);
  }
  try {
    return serverInstallOwnershipSchema.parse(
      JSON.parse(await readFile(layout.installFile, "utf8")),
    );
  } catch (error) {
    throw new Error(`ZCode Server ownership marker is invalid: ${layout.installFile}`, {
      cause: error,
    });
  }
}

export async function ensureServerInstallOwnership(
  layout: ServerLayout,
  targetId?: string,
): Promise<ServerInstallOwnership> {
  if (
    targetId !== undefined &&
    (targetId.length === 0 || targetId.length > 256 || targetId.trim() !== targetId)
  ) {
    throw new Error("Invalid ZCode Server target identity");
  }
  await mkdir(layout.serverRoot, { recursive: true, mode: 0o700 });
  const canonicalServerRoot = await realpath(layout.serverRoot);
  const ownership: ServerInstallOwnership = {
    product: SERVER_INSTALL_OWNERSHIP_PRODUCT,
    schemaVersion: SERVER_INSTALL_OWNERSHIP_SCHEMA_VERSION,
    canonicalServerRoot,
    installationId: randomUUID(),
    installedAt: Date.now(),
  };
  await mkdir(layout.runDir, { recursive: true, mode: 0o700 });
  const temporary = join(layout.runDir, `install-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(ownership, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    try {
      // 直接 open install.json 后再写入会先暴露空文件，并发 ensure 可能把
      // 它判成损坏 marker。hard-link 只在临时文件完整落盘后原子发布且不会覆盖旧标记。
      await link(temporary, layout.installFile);
      if (targetId) {
        return await bindExistingOwnershipTarget(layout, ownership, targetId);
      }
      return ownership;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      const existing = await validateServerInstallOwnership(layout);
      return targetId ? await bindExistingOwnershipTarget(layout, existing, targetId) : existing;
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

/**
 * Target identity is an explicit Desktop compatibility binding, separate from
 * the installation ID used to own a standalone server root. Callers serialize
 * this one-time binding with the existing data-root lock before Core starts.
 */
async function bindExistingOwnershipTarget(
  layout: ServerLayout,
  ownership: ServerInstallOwnership,
  targetId: string,
): Promise<ServerInstallOwnership> {
  if (ownership.targetId === targetId) return ownership;
  if (ownership.targetId) {
    throw new Error("ZCode Server target identity conflicts with its persisted installation");
  }
  const updated = serverInstallOwnershipSchema.parse({ ...ownership, targetId });
  const temporary = join(layout.runDir, `install-target-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, layout.installFile);
    return updated;
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export async function validateServerInstallOwnership(
  layout: ServerLayout,
): Promise<ServerInstallOwnership> {
  const [ownership, canonicalServerRoot] = await Promise.all([
    readOwnership(layout),
    realpath(layout.serverRoot).catch((error: unknown) => {
      throw new Error(`ZCode Server ownership root cannot be resolved: ${layout.serverRoot}`, {
        cause: error,
      });
    }),
  ]);
  if (ownership.canonicalServerRoot !== canonicalServerRoot) {
    throw new Error(
      `ZCode Server ownership root mismatch: expected ${ownership.canonicalServerRoot}, received ${canonicalServerRoot}`,
    );
  }
  return ownership;
}
