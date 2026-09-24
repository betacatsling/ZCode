/* Public Core + real CLI/SQLite boot ingress probe in the parent's disposable profile. */
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createCoreAuthority } from "@zcode/services/node";
import {
  IProjectCatalogRpcService,
  IWorkspaceHierarchyService,
  IZCodeAgentService,
} from "@zcode/services";
import { join } from "node:path";

let core: Awaited<ReturnType<typeof createCoreAuthority>> | undefined;
try {
  core = await createCoreAuthority({
    installationId: "native-mount-fixture",
    profileRoot: process.env.ZCODE_DATA_BASE_DIR!,
    zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
    admissionFence: "held",
  });
  await core.reconcileBeforeAdmission();
  assert.ok(core.bootAdmissionLease);
  const service = core.services.get(IZCodeAgentService);
  const catalog = core.services.get(IProjectCatalogRpcService);
  const hierarchy = core.services.get(IWorkspaceHierarchyService);
  const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH!, { readOnly: true });
  const count = () =>
    (db.prepare("select count(*) as total from session").get() as { total: number }).total;
  const before = count();
  const original = await hierarchy.inspectCreateCommand({
    workspaceId: "workspace",
    commandId: "native-create-1",
  });
  assert.equal(original.status, "completed");
  if (original.status === "completed") {
    assert.equal(original.owner.historyOnly, false);
    const wrong = {
      workspacePath: original.owner.scope.workspacePath,
      workspaceIdentity: "foreign-identity",
      remoteSessionId: "attachment-current",
      generation: 2,
    };
    await assert.rejects(
      hierarchy.inspectCreateCommand({
        workspaceId: "workspace",
        commandId: "native-create-1",
        attachment: wrong,
      }),
      /attachment scope/,
    );
    const currentView = await hierarchy.inspectCreateCommand({
      workspaceId: "workspace",
      commandId: "native-create-1",
      attachment: { ...wrong, workspaceIdentity: original.owner.scope.workspaceIdentity },
    });
    assert.equal(currentView.status, "completed");
    if (currentView.status === "completed") {
      assert.equal(currentView.owner.originalSessionId, original.owner.originalSessionId);
      assert.equal(currentView.owner.scope.remoteSessionId, "attachment-current");
    }
  }
  assert.deepEqual(
    await hierarchy.inspectCreateCommand({
      workspaceId: "workspace",
      commandId: "never-submitted",
    }),
    { status: "unknown" },
  );
  assert.equal(count(), before, "pure inspection must not allocate");
  const target = { workspacePath: process.cwd() };
  const command = (id: string) => ({
    commandId: id,
    clientId: "boot-fixture",
    sessionId: null,
    type: "createSession" as const,
    issuedAt: Date.now(),
    payload: {
      workspaceId: process.cwd(),
      config: {
        modelSelection: {
          providerId: "fixture",
          modelId: "fixture-model",
          options: { reasoningLevel: "off" },
        },
        mode: "build" as const,
      },
    },
  });
  await assert.rejects(
    service.sendConversationCommandV4({ ...target, envelope: command("boot-denied") }),
    /guard.nativeMaintenanceFrozen/,
  );
  assert.equal(count(), before, "constructor-held Inbox cannot allocate");
  await assert.rejects(
    catalog.importProject({
      id: "boot-denied",
      name: "Boot denied",
      targetId: "native-mount-fixture",
      repositoryPath: join(process.env.ZCODE_DATA_BASE_DIR!, "real-repo"),
      bindingId: "boot-denied",
    }),
    /frozen/,
  );
  // The ordinary maintenance path still demands real fresh idle, not a fake boot census.
  const ordinary = await core.maintenance.freezeAdmissions();
  await assert.rejects(core.bootAdmissionLease.release(), /maintenance in progress/);
  await ordinary.release();
  await core.bootAdmissionLease.release();
  await core.bootAdmissionLease.release();
  if (original.status === "completed") {
    const retry = await hierarchy.createAgent({
      workspaceId: "workspace",
      harnessId: "zcode",
      commandId: "native-create-1",
      modelBinding: {
        kind: "host-managed",
        selection: {
          providerId: "fixture",
          modelId: "fixture-model",
          options: { reasoningLevel: "off" },
        },
      },
      attachment: {
        workspacePath: original.owner.scope.workspacePath,
        workspaceIdentity: original.owner.scope.workspaceIdentity,
        remoteSessionId: "attachment-renewed",
        generation: 3,
      },
    });
    assert.equal(retry.owner.kind, "native");
    if (retry.owner.kind === "native") {
      assert.equal(retry.owner.originalSessionId, original.owner.originalSessionId);
      assert.equal(retry.owner.scope.remoteSessionId, "attachment-renewed");
    }
    assert.equal(count(), before, "new attachment cannot allocate to recover old command");
  }
  const accepted = await service.sendConversationCommandV4({
    ...target,
    envelope: command("boot-open"),
  });
  assert.equal(accepted.status, "accepted");
  assert.equal(count(), before + 1, "same original CLI worker allocates only after opening");
  db.close();
  process.send?.({
    type: "boot-held",
    before,
    after: before + 1,
    heldReason: "guard.nativeMaintenanceFrozen",
  });
} catch (error) {
  process.send?.({ type: "error", reason: String(error) });
  process.exitCode = 1;
} finally {
  await core?.dispose();
  process.disconnect?.();
}
