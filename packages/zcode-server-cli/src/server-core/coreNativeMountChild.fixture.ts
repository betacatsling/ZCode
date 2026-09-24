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
  if (process.argv[2] !== "restart") {
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
  if (process.argv[2] !== "restart")
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
                  personalModelIds: ["fixture-model"],
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
  authority = await createCoreAuthority({
    installationId: "native-mount-fixture",
    profileRoot: root,
    zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
  });
  await authority.reconcileBeforeAdmission();
  const catalog = authority.services.get(IProjectCatalogRpcService);
  const hierarchy = authority.services.get(IWorkspaceHierarchyService);
  if (process.argv[2] !== "restart") {
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
  for (const commandId of ["native-create-1", "native-create-2"]) {
    const created = await hierarchy.createAgent({
      workspaceId: "workspace",
      harnessId: "zcode",
      commandId,
      modelBinding: binding,
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
  if (ids[0] === ids[1]) throw new Error("two commands allocated one session");
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
  let fsyncFailed = false;
  if (process.argv[2] !== "restart") {
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
    const allocated = await sessionCount();
    if (allocated !== 3) throw new Error(`unexpected native allocations: ${allocated}`);
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
    const subscription = await service.subscribeConversationV4({
      workspacePath: repo,
      workspaceIdentity: repo,
      sessionId: ids[0]!,
      visibility: "foreground",
    });
    if (!subscription.ack.subscriptionId) throw new Error("native cold attachment unavailable");
    const ack = await service.sendConversationCommandV4({
      workspacePath: repo,
      workspaceIdentity: repo,
      envelope: {
        commandId: "real-first-input",
        clientId: "native-mount-fixture",
        sessionId: ids[0]!,
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
        sessionId: ids[0]!,
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
  const worktrees = await git("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  process.send?.({
    type: "native-created",
    ids,
    fsyncFailed,
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
