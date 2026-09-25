/* Real public Core + existing CLI completed receipt, never a synthetic success callback. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createCoreAuthority } from "@zcode/services/node";
import { IProjectCatalogRpcService, IWorkspaceHierarchyService } from "@zcode/services";

const git = promisify(execFile);
const raceMode = process.argv[2];
const certificatePaused = deferred<void>();
const resumeCertificate = deferred<void>();
const nativeFenceAcquired = deferred<void>();
const workspaceAdmissionObserved = deferred<void>();
let observeNativeFence = false;
let observeWorkspaceAdmission = false;
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

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
    testOnlyAfterCompletedCertificate:
      raceMode === "archive-drain" || raceMode === "git-swap" || raceMode === "dispose-drain"
        ? async (id) => {
            if (id !== commandId) return;
            if (raceMode === "git-swap") {
              // 中文：只替换本测试临时仓库的 Git admin inode，模拟证书 await 期间外部重建。
              await rename(join(root, "real-repo", ".git"), join(root, "original-git-admin"));
              await git("git", ["-C", join(root, "real-repo"), "init", "-q"]);
              return;
            }
            certificatePaused.resolve();
            await resumeCertificate.promise;
          }
        : undefined,
    testOnlyAfterNativeMaintenanceFence:
      raceMode === "archive-drain"
        ? () => {
            if (observeNativeFence) nativeFenceAcquired.resolve();
          }
        : undefined,
    testOnlyOnWorkspaceAdmission:
      raceMode === "archive-drain"
        ? () => {
            if (observeWorkspaceAdmission) {
              observeWorkspaceAdmission = false;
              workspaceAdmissionObserved.resolve();
            }
          }
        : undefined,
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
  if (raceMode === "git-swap") {
    const initial = await bytes();
    await assert.rejects(
      hierarchy.reconcileCompletedCreateCommand(request),
      /repository|workspace|instance|Target/i,
    );
    assert.ok(
      (await bytes()).every((part, i) => part.equals(initial[i]!)),
      "changed Git admin identity must refuse before mapping/reference writes",
    );
    assert.equal(initial[0]!.length, 0, "the real completion remains unmapped");
    process.send?.({ type: "coreCompletedGitSwap", rejectedBeforeWrite: true });
  } else if (raceMode === "archive-drain") {
    const order: string[] = [];
    const repair = hierarchy.reconcileCompletedCreateCommand(request).then((result) => {
      order.push("repair-completed");
      return result;
    });
    await certificatePaused.promise;
    const catalog = core.services.get(IProjectCatalogRpcService);
    observeWorkspaceAdmission = true;
    const archive = catalog.updateWorkspace("workspace", { archived: true }).then((result) => {
      order.push("archive-completed");
      return result;
    });
    await workspaceAdmissionObserved.promise;
    observeNativeFence = true;
    const freeze = core.maintenance.freezeAdmissions().then((lease) => {
      order.push("maintenance-granted");
      return lease;
    });
    await nativeFenceAcquired.promise;
    assert.deepEqual(order, [], "freeze must not issue idle while certificate repair is paused");
    resumeCertificate.resolve();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const joined = await Promise.race([
      Promise.all([repair, archive, freeze]),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(
          () => reject(new Error("repair/archive/freeze drain deadlocked")),
          8000,
        );
      }),
    ]).finally(() => clearTimeout(watchdog));
    const [repaired, archived, lease] = joined;
    assert.equal(repaired.status, "completed");
    if (repaired.status !== "completed") throw new Error("Expected completed repair");
    assert.equal(repaired.owner.originalSessionId, originalId);
    assert.equal(archived.archived, true);
    assert.deepEqual(order.slice(-1), ["maintenance-granted"]);
    const serializedOrder = order.join("|");
    const grantIndex = serializedOrder.indexOf("maintenance-granted");
    assert.ok(serializedOrder.indexOf("repair-completed") < grantIndex);
    assert.ok(serializedOrder.indexOf("archive-completed") < grantIndex);
    const committed = await bytes();
    assert.ok(committed[0]!.length > 0, "mapping fsync must precede the idle lease");
    const refs = JSON.parse(committed[1]!.toString()).nativeReferences as Array<{
      commandId: string;
    }>;
    assert.equal(refs.filter((row) => row.commandId === commandId).length, 1);
    await lease.release();
    process.send?.({ type: "coreCompletedArchiveDrain", order, references: 1 });
  } else if (raceMode === "dispose-drain") {
    const order: string[] = [];
    const repair = hierarchy.reconcileCompletedCreateCommand(request).then((result) => {
      order.push("repair-completed");
      return result;
    });
    await certificatePaused.promise;
    const disposing = core.dispose().then(() => order.push("disposed"));
    resumeCertificate.resolve();
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const joined = await Promise.race([
      Promise.all([repair, disposing]),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error("Core disposal did not drain repair")), 10000);
      }),
    ]).finally(() => clearTimeout(watchdog));
    const [repaired] = joined;
    assert.equal(repaired.status, "completed");
    assert.deepEqual(order, ["repair-completed", "disposed"]);
    const committed = await bytes();
    assert.ok(committed[0]!.length > 0);
    const refs = JSON.parse(committed[1]!.toString()).nativeReferences as Array<{
      commandId: string;
    }>;
    assert.equal(refs.filter((row) => row.commandId === commandId).length, 1);
    process.send?.({ type: "coreCompletedDisposeDrain", order, references: 1 });
  } else {
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
    const refs = JSON.parse(written[1]!.toString()).nativeReferences as Array<{
      commandId: string;
    }>;
    process.send?.({
      type: "coreCompletedRepair",
      originalId,
      heldBoot,
      heldMaintenance,
      afterRelease: true,
      references: refs.filter((row) => row.commandId === commandId).length,
    });
  }
} catch (error) {
  process.send?.({ type: "error", reason: String(error) });
  process.exitCode = 1;
} finally {
  await core?.dispose();
  process.disconnect?.();
}
