/* eslint-disable max-lines -- Isolated public-factory Git/CLI/SQLite subprocess fixture shares one lifetime and one profile. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createCoreAuthority } from "@zcode/services/node";
import {
  IProjectCatalogRpcService,
  IWorkspaceHierarchyService,
  IZCodeAgentService,
} from "@zcode/services";

const git = promisify(execFile);
const root = process.env.ZCODE_DATA_BASE_DIR!;
let authority: Awaited<ReturnType<typeof createCoreAuthority>> | undefined;
try {
  const repo = join(root, "real-repo");
  await mkdir(repo, { recursive: true });
  if (process.argv[2] !== "restart" && process.argv[2] !== "source-next") {
    await git("git", ["init", "-q", repo]);
    await writeFile(join(repo, "README"), "isolated\n");
    await git("git", ["-C", repo, "add", "README"]);
    await git("git", [
      "-C",
      repo,
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "user.name=fixture",
      "commit",
      "-qm",
      "initial",
    ]);
  }
  const settings = join(root, ".zcode", "v2");
  await mkdir(settings, { recursive: true });
  if (process.argv[2] !== "restart" && process.argv[2] !== "source-next")
    await writeFile(
      join(settings, "provider_config.json"),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "fixture",
                providerName: "Fixture",
                enabled: true,
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "fixture-only-not-a-credential" },
                  api: {
                    type: "anthropic-messages",
                    baseUrl: process.env.CORE_NATIVE_FIXTURE_URL!,
                  },
                  personalModelIds: ["fixture-model", "fixture-other"],
                },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              {
                providerId: "fixture",
                modelId: "fixture-model",
                config: {
                  enabled: true,
                  properties: {
                    contextWindow: 65536,
                    supportsJsonSchemaOutput: false,
                    supportsNativeWebSearch: false,
                    supportsMidConversationSystem: true,
                    supportsToolCall: true,
                    requiresMfjsToolSchema: false,
                    inputFormat: {
                      supportsText: true,
                      supportsImage: false,
                      supportsVideo: false,
                      supportsAudio: false,
                      supportsPdf: false,
                    },
                    outputFormat: { supportsText: true },
                  },
                  optionSpecs: {
                    reasoningLevel: { values: ["off"], map: "{}" },
                    maxOutputTokens: { max: 2048, map: "{}" },
                  },
                },
              },
            ],
            // A second valid, non-default model on the same provider exercises immutable selection.
            manualProviderModelRules: [],
          },
          defaultModelSelection: {
            providerId: "fixture",
            modelId: "fixture-model",
            options: { reasoningLevel: "off" },
          },
        },
      }),
    );
  if (process.argv[2] !== "restart" && process.argv[2] !== "source-next") {
    const path = join(settings, "provider_config.json");
    const data = JSON.parse(await (await import("node:fs/promises")).readFile(path, "utf8"));
    data.config.modelConfigRules.providerModelRules.push({
      ...data.config.modelConfigRules.providerModelRules[0],
      modelId: "fixture-other",
    });
    await writeFile(path, JSON.stringify(data));
  }
  authority = await createCoreAuthority({
    installationId: "native-mount-fixture",
    profileRoot: root,
    zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
    admissionFence: process.env.CORE_NATIVE_BOOT_FENCE_TEST_ONLY === "1" ? "held" : "open",
    testOnlyAfterNativeDescribe:
      process.env.CORE_INGRESS_ROTATE_WORKER_TEST_ONLY === "1" ||
      process.env.CORE_INGRESS_SCHEMA_BETWEEN_TEST_ONLY === "1"
        ? async (commandId, target) => {
            if (commandId === "native-create-worker-rotation")
              await authority!.services.get(IZCodeAgentService).disposeWorkspace(target);
            if (commandId === "native-create-schema-between") {
              // 中文：仅 fixture 修改真实独立 SQLite；Core 生产代码不能写 CLI 业务数据库。
              const { DatabaseSync } = await import("node:sqlite");
              const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH!);
              try {
                db.exec("pragma user_version = 1");
              } finally {
                db.close();
              }
            }
          }
        : undefined,
  });
  await authority.reconcileBeforeAdmission();
  const catalog = authority.services.get(IProjectCatalogRpcService);
  if (process.env.CORE_NATIVE_BOOT_FENCE_TEST_ONLY === "1") {
    // 中文：真实 Core/Target/Catalog 即使已完成启动核对，也不得在 Supervisor 决策前接收新命令。
    if (!authority.bootAdmissionLease) throw new Error("missing held boot lease");
    try {
      await catalog.importProject({
        id: "premature",
        name: "Premature",
        targetId: "native-mount-fixture",
        repositoryPath: join(root, "real-repo"),
        bindingId: "premature-binding",
      });
      throw new Error("held Core accepted mutation");
    } catch (error) {
      if (!String(error).includes("frozen")) throw error;
    }
    await authority.bootAdmissionLease.release();
    await authority.bootAdmissionLease.release();
  }
  const hierarchy = authority.services.get(IWorkspaceHierarchyService);
  if (process.argv[2] !== "restart" && process.argv[2] !== "source-next") {
    await catalog.importProject({
      id: "project",
      name: "Test",
      targetId: "native-mount-fixture",
      repositoryPath: repo,
      bindingId: "binding",
    });
    await catalog.adopt({
      bindingId: "binding",
      workspaceId: "workspace",
      title: "Main",
      worktreePath: repo,
    });
  }
  const binding = {
    kind: "host-managed" as const,
    selection: {
      providerId: "fixture",
      modelId: "fixture-model",
      options: { reasoningLevel: "off" },
    },
  };
  const options = await hierarchy.listCreateOptions("workspace");
  if (
    process.argv[2] !== "restart" &&
    !options.options.some(
      (row) => row.harnessId === "zcode" && JSON.stringify(row.binding) === JSON.stringify(binding),
    )
  )
    throw new Error("real native model options unavailable");
  const ids: string[] = [];
  const commands =
    process.argv[2] === "source-next"
      ? ["native-create-source-next"]
      : ["native-create-1", "native-create-2"];
  for (const commandId of commands) {
    const requested =
      commandId === "native-create-1"
        ? binding
        : {
            kind: "host-managed" as const,
            selection: { ...binding.selection, modelId: "fixture-other" },
          };
    const created = await hierarchy.createAgent({
      workspaceId: "workspace",
      harnessId: "zcode",
      commandId,
      modelBinding: requested,
    });
    if (created.owner.kind !== "native" || !created.owner.originalSessionId)
      throw new Error("not an original native ID");
    ids.push(created.owner.originalSessionId);
    const resolved = await hierarchy.resolveOwner({
      targetId: "native-mount-fixture",
      workspaceId: "workspace",
      sessionId: created.owner.originalSessionId,
    });
    if (
      resolved?.kind !== "native" ||
      resolved.historyOnly ||
      resolved.originalSessionId !== created.owner.originalSessionId
    )
      throw new Error("new mapping not joined as writable original owner");
  }
  let workerRotation: string | undefined;
  let raceAllocated: boolean | undefined;
  if (
    process.env.CORE_INGRESS_ROTATE_WORKER_TEST_ONLY === "1" ||
    process.env.CORE_INGRESS_SCHEMA_BETWEEN_TEST_ONLY === "1"
  ) {
    const before = await (async () => {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH!, { readOnly: true });
      try {
        return (db.prepare("select count(*) as total from session").get() as { total: number })
          .total;
      } finally {
        db.close();
      }
    })();
    const schemaBetween = process.env.CORE_INGRESS_SCHEMA_BETWEEN_TEST_ONLY === "1";
    const raceCommand = schemaBetween
      ? "native-create-schema-between"
      : "native-create-worker-rotation";
    try {
      await hierarchy.createAgent({
        workspaceId: "workspace",
        harnessId: "zcode",
        commandId: raceCommand,
        modelBinding: {
          kind: "host-managed",
          selection: {
            providerId: "fixture",
            modelId: "fixture-model",
            options: { reasoningLevel: "off" },
          },
        },
      });
      throw new Error("rotated real CLI worker accepted stale create");
    } catch (error) {
      workerRotation = String(error).includes("native-create-owner-changed-before-effect")
        ? "native-create-owner-changed-before-effect"
        : String(error).includes("unknown-native-session-schema")
          ? "unknown-native-session-schema"
          : String(error);
    } finally {
      if (schemaBetween) {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH!);
        try {
          db.exec("pragma user_version = 0");
        } finally {
          db.close();
        }
      }
    }
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH!, { readOnly: true });
    try {
      raceAllocated =
        (db.prepare("select count(*) as total from session").get() as { total: number }).total !==
          before ||
        db
          .prepare("select command_id from native_create_receipt where command_id = ?")
          .get(raceCommand) !== undefined;
    } finally {
      db.close();
    }
  }
  // Real public factory must durably reference each certified original ID in the Catalog,
  // not merely expose the standalone native-create mapping.
  const catalogState = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile(
      join(root, ".zcode", "v2", "workspace-hierarchy", "profile", "catalog.json"),
      "utf8",
    ),
  ) as {
    nativeReferences?: Array<{ commandId: string; originalSessionId: string; workspaceId: string }>;
  };
  for (const [index, commandId] of commands.entries()) {
    if (
      !catalogState.nativeReferences?.some(
        (row) =>
          row.commandId === commandId &&
          row.originalSessionId === ids[index] &&
          row.workspaceId === "workspace",
      )
    )
      throw new Error(`missing durable Catalog reference: ${commandId}`);
  }
  if (ids.length === 2 && ids[0] === ids[1]) throw new Error("two commands allocated one session");
  const nativeDb = process.env.ZCODE_SESSION_DB_PATH!.startsWith("/")
    ? process.env.ZCODE_SESSION_DB_PATH!
    : join(repo, process.env.ZCODE_SESSION_DB_PATH!);
  const sessionCount = async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(nativeDb, { readOnly: true });
    try {
      return (db.prepare("select count(*) as total from session").get() as { total: number }).total;
    } finally {
      db.close();
    }
  };
  if (process.env.CORE_NATIVE_FAILURE_BOUNDARY_TEST_ONLY === "schema") {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH!);
    db.exec("pragma user_version = 1");
    try {
      // 中文：在两个已认证原始 ID 后损坏实际 CLI 源库版本；公共工厂不得在效果前分配第三个。
      try {
        await hierarchy.createAgent({
          workspaceId: "workspace",
          harnessId: "zcode",
          commandId: "native-create-schema-boundary",
          modelBinding: binding,
        });
        throw new Error("unsupported actual source DB accepted by public factory");
      } catch (error) {
        if (!String(error).includes("unknown-native-session-schema")) throw error;
      }
      const receipt = db
        .prepare("select session_id from native_create_receipt where command_id = ?")
        .get("native-create-schema-boundary");
      if (receipt) throw new Error("unsupported source allocated a native ID");
    } finally {
      db.exec("pragma user_version = 0");
      db.close();
    }
    process.send?.({ type: "boundary-schema", ids, worktreeCount: 1 });
  }
  if (
    process.env.CORE_NATIVE_FAILURE_BOUNDARY_TEST_ONLY &&
    process.env.CORE_NATIVE_FAILURE_BOUNDARY_TEST_ONLY !== "schema"
  ) {
    const kind = process.env.CORE_NATIVE_FAILURE_BOUNDARY_TEST_ONLY;
    const commandId = `native-create-${kind}-boundary`;
    let failed = false;
    try {
      await hierarchy.createAgent({
        workspaceId: "workspace",
        harnessId: "zcode",
        commandId,
        modelBinding: binding,
      });
    } catch (error) {
      // 中文：CLI 把内部 post-COMMIT 故障编码为 failed ACK；下方 SQLite pending 校验证明故障点。
      if (
        String(error).includes(
          kind === "pending" ? "native-create-command-failed" : "before-core-mapping-test-only",
        )
      )
        failed = true;
      else throw error;
    }
    if (!failed) throw new Error(`actual public factory ${kind} boundary did not fail`);
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH!, { readOnly: true });
    const receipt = db
      .prepare("select status, session_id as id from native_create_receipt where command_id = ?")
      .get(commandId) as { status: string; id: string } | undefined;
    db.close();
    if (receipt?.status !== (kind === "pending" ? "pending" : "completed"))
      throw new Error(`wrong durable CLI boundary status: ${receipt?.status}`);
    const boundaryWorktrees = await git("git", ["-C", repo, "worktree", "list", "--porcelain"]);
    process.send?.({
      type: "boundary-staged",
      kind,
      commandId,
      originalId: receipt.id,
      ids,
      worktreeCount: boundaryWorktrees.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree ")).length,
    });
  }
  let fsyncFailed = false;
  let catalogFailed = process.argv[2] === "restart";
  if (
    process.argv[2] !== "restart" &&
    process.argv[2] !== "source-next" &&
    !process.env.CORE_NATIVE_FAILURE_BOUNDARY_TEST_ONLY
  ) {
    try {
      await hierarchy.createAgent({
        workspaceId: "workspace",
        harnessId: "zcode",
        commandId: "native-create-fsync-fault",
        modelBinding: binding,
      });
    } catch (error) {
      if (String(error).includes("directory-sync-fault-test-only")) fsyncFailed = true;
      else throw error;
    }
    if (!fsyncFailed) throw new Error("mapping fsync failure incorrectly returned success");
    const mappingPath = join(
      root,
      ".zcode",
      "v2",
      "native-create",
      `${createHash("sha256").update("native-create-fsync-fault").digest("hex")}.mapping.json`,
    );
    try {
      await access(mappingPath);
      throw new Error("unfsynced mapping leaked into directory reads");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      await hierarchy.createAgent({
        workspaceId: "workspace",
        harnessId: "zcode",
        commandId: "native-create-catalog-fault",
        modelBinding: binding,
      });
    } catch (error) {
      if (String(error).includes("native-catalog-commit-fault-test-only")) catalogFailed = true;
      else throw error;
    }
    if (!catalogFailed) throw new Error("Catalog failure incorrectly returned success");
    const catalogState = JSON.parse(
      await (
        await import("node:fs/promises")
      ).readFile(
        join(root, ".zcode", "v2", "workspace-hierarchy", "profile", "catalog.json"),
        "utf8",
      ),
    );
    if (
      catalogState.nativeReferences?.some(
        (row: { commandId: string }) => row.commandId === "native-create-catalog-fault",
      )
    )
      throw new Error("failed Catalog reference visible");
    const missing = await hierarchy.resolveOwner({
      targetId: "native-mount-fixture",
      workspaceId: "workspace",
      sessionId: await (async () => {
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(nativeDb, { readOnly: true });
        try {
          return (
            db
              .prepare("select session_id as id from native_create_receipt where command_id = ?")
              .get("native-create-catalog-fault") as { id: string }
          ).id;
        } finally {
          db.close();
        }
      })(),
    });
    if (missing) throw new Error("unreferenced mapping visible in directory");
    const allocated = await sessionCount();
    if (allocated !== 4) throw new Error(`unexpected native allocations: ${allocated}`);
    try {
      await hierarchy.createAgent({
        workspaceId: "workspace",
        harnessId: "zcode",
        commandId: "native-create-1",
        modelBinding: {
          kind: "host-managed",
          selection: { providerId: "fixture", modelId: "fixture-model" },
        },
      });
      throw new Error("wrong model reused completed original ID");
    } catch (error) {
      if (!String(error).includes("native-create-intent-conflict")) throw error;
    }
    if ((await sessionCount()) !== allocated)
      throw new Error("wrong-model retry allocated another native ID");
    if (
      (await hierarchy.resolveWorkspace({
        workspacePath: repo,
        workspaceIdentity: "opaque:other",
        targetId: "native-mount-fixture",
      })) !== undefined
    )
      throw new Error("opaque identity collapsed to shared filesystem path");
  }
  if (process.argv[2] === "restart") {
    const repaired = await hierarchy.createAgent({
      workspaceId: "workspace",
      harnessId: "zcode",
      commandId: "native-create-catalog-fault",
      modelBinding: binding,
    });
    if (repaired.owner.kind !== "native" || !repaired.owner.originalSessionId)
      throw new Error("completed Catalog repair unavailable under disabled admission");
    const before = await sessionCount();
    try {
      await hierarchy.createAgent({
        workspaceId: "workspace",
        harnessId: "zcode",
        commandId: "native-new-disabled",
        modelBinding: binding,
      });
      throw new Error("disabled new admission allocated a native ID");
    } catch (error) {
      if (!String(error).includes("receipt unavailable") && !String(error).includes("admission"))
        throw error;
    }
    if ((await sessionCount()) !== before) throw new Error("disabled admission wrote CLI DB");
    const service = authority.services.get(IZCodeAgentService);
    for (const [index, id] of ids.entries()) {
      const subscription = await service.subscribeConversationV4({
        workspacePath: repo,
        workspaceIdentity: repo,
        sessionId: id,
        visibility: "foreground",
      });
      if (!subscription.ack.subscriptionId) throw new Error("native cold attachment unavailable");
      const ack = await service.sendConversationCommandV4({
        workspacePath: repo,
        workspaceIdentity: repo,
        envelope: {
          commandId: `real-first-input-${index}`,
          clientId: "native-mount-fixture",
          sessionId: id,
          type: "sendText",
          issuedAt: Date.now(),
          payload: { text: "fixture input after restart" },
        },
      });
      if (ack.status !== "accepted") throw new Error(`real input rejected: ${JSON.stringify(ack)}`);
      let terminal = false;
      let last: unknown;
      for (let i = 0; i < 80; i++) {
        const snapshot = await service.readSession({
          workspacePath: repo,
          workspaceIdentity: repo,
          sessionId: id,
        });
        last = {
          status: snapshot.session.status,
          model: snapshot.session.model,
          messages: snapshot.messages.length,
          active: snapshot.runtime.activeTurnId,
          pending: snapshot.runtime.pendingRequestIds,
        };
        if (
          snapshot.session.status === "completed" ||
          (snapshot.session.status === "idle" &&
            snapshot.messages.some(
              (row) => row.info.role === "assistant" && row.info.time.completed !== undefined,
            ))
        ) {
          terminal = true;
          break;
        }
        if (snapshot.session.status === "error") throw new Error("native turn failed");
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (!terminal) throw new Error(`native turn did not reach terminal: ${JSON.stringify(last)}`);
      await service.unsubscribeConversationV4({
        workspacePath: repo,
        workspaceIdentity: repo,
        subscriptionId: subscription.ack.subscriptionId,
      });
    }
  }
  const worktrees = await git("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  process.send?.({
    type: "native-created",
    ids,
    fsyncFailed,
    catalogFailed,
    workerRotation,
    raceAllocated,
    worktreeCount: worktrees.stdout.split("\n").filter((line) => line.startsWith("worktree "))
      .length,
  });
} catch (error) {
  const db = process.env.ZCODE_SESSION_DB_PATH;
  let schema = "missing";
  if (db) {
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const connection = new DatabaseSync(db, { readOnly: true });
      schema = JSON.stringify(
        connection.prepare("SELECT id FROM schema_migration ORDER BY id").all(),
      );
      connection.close();
    } catch (probe) {
      schema = String(probe);
    }
  }
  process.send?.({
    type: "native-error",
    reason: error instanceof Error ? error.stack : String(error),
    schema,
  });
  process.exitCode = 1;
} finally {
  await authority?.dispose();
  process.disconnect?.();
}
