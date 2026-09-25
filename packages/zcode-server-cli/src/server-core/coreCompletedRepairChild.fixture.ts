/* Real public Core + existing CLI completed receipt, never a synthetic success callback. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createCoreAuthority } from "@zcode/services/node";
import { IWorkspaceHierarchyService } from "@zcode/services";

const root = process.env.ZCODE_DATA_BASE_DIR!;
const commandId = "native-create-completed-boundary";
const originalId = process.env.CORE_COMPLETED_ORIGINAL_ID!;
const mapping = join(
  root,
  ".zcode",
  "v2",
  "native-create",
  `${createHash("sha256").update(commandId).digest("hex")}.mapping.json`,
);
const catalog = join(root, ".zcode", "v2", "workspace-hierarchy", "profile", "catalog.json");
const bytes = async () => [
  await readFile(mapping).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return Buffer.alloc(0);
    throw error;
  }),
  await readFile(catalog),
];
const binding = {
  kind: "host-managed" as const,
  selection: {
    providerId: "fixture",
    modelId: "fixture-model",
    options: { reasoningLevel: "off" },
  },
};
let core: Awaited<ReturnType<typeof createCoreAuthority>> | undefined;
try {
  core = await createCoreAuthority({
    installationId: "native-mount-fixture",
    profileRoot: root,
    zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
    admissionFence: "held",
  });
  await core.reconcileBeforeAdmission();
  const hierarchy = core.services.get(IWorkspaceHierarchyService);
  const request = { workspaceId: "workspace", commandId };
  const retry = { ...request, harnessId: "zcode", modelBinding: binding };
  const pending = await hierarchy.inspectCreateCommand(request);
  assert.equal(pending.status, "completed-unindexed");
  assert.equal(pending.originalSessionId, originalId);
  const initial = await bytes();
  await assert.rejects(hierarchy.createAgent(retry), /frozen|admission|maintenance/i);
  const heldBoot = (await bytes()).every((part, i) => part.equals(initial[i]!));
  assert.ok(heldBoot, "held boot must not write mapping or Catalog");
  await assert.rejects(
    hierarchy.reconcileCompletedCreateCommand(request),
    /frozen|admission|maintenance/i,
  );
  assert.ok((await bytes()).every((part, i) => part.equals(initial[i]!)));
  await core.bootAdmissionLease!.release();
  const lease = await core.maintenance.freezeAdmissions();
  let heldMaintenance = false;
  try {
    await assert.rejects(hierarchy.createAgent(retry), /frozen|admission|maintenance/i);
    await assert.rejects(
      hierarchy.reconcileCompletedCreateCommand(request),
      /frozen|admission|maintenance/i,
    );
    heldMaintenance = (await bytes()).every((part, i) => part.equals(initial[i]!));
  } finally {
    await lease.release();
  }
  assert.ok(heldMaintenance);
  // Production new-create is OFF. Both paths share completed-only metadata admission.
  if (process.env.CORE_COMPLETED_RETRY_FIRST === "1") {
    const [old, explicit] = await Promise.all([
      hierarchy.createAgent(retry),
      hierarchy.reconcileCompletedCreateCommand(request),
    ]);
    assert.equal(old.owner.kind, "native");
    assert.equal(explicit.status, "completed");
    if (old.owner.kind !== "native" || explicit.status !== "completed")
      throw new Error("Expected native repair owner");
    assert.equal(old.owner.originalSessionId, originalId);
    assert.equal(explicit.owner.originalSessionId, originalId);
  } else {
    const repairs = await Promise.all([
      hierarchy.reconcileCompletedCreateCommand(request),
      hierarchy.reconcileCompletedCreateCommand(request),
    ]);
    for (const result of repairs) {
      assert.equal(result.status, "completed");
      if (result.status !== "completed") throw new Error("Expected completed repair");
      assert.equal(result.owner.originalSessionId, originalId);
    }
  }
  const written = await bytes();
  const [oldRetry, explicitRetry] = await Promise.all([
    hierarchy.createAgent(retry),
    hierarchy.reconcileCompletedCreateCommand(request),
  ]);
  assert.equal(oldRetry.owner.kind, "native");
  if (oldRetry.owner.kind !== "native" || explicitRetry.status !== "completed")
    throw new Error("Expected indexed native owner");
  assert.equal(oldRetry.owner.originalSessionId, originalId);
  assert.equal(explicitRetry.owner.originalSessionId, originalId);
  assert.ok(
    (await bytes()).every((part, i) => part.equals(written[i]!)),
    "indexed retries are readonly",
  );
  const refs = JSON.parse(written[1]!.toString()).nativeReferences as Array<{ commandId: string }>;
  process.send?.({
    type: "coreCompletedRepair",
    originalId,
    heldBoot,
    heldMaintenance,
    afterRelease: true,
    references: refs.filter((row) => row.commandId === commandId).length,
  });
} catch (error) {
  process.send?.({ type: "error", reason: String(error) });
  process.exitCode = 1;
} finally {
  await core?.dispose();
  process.disconnect?.();
}
