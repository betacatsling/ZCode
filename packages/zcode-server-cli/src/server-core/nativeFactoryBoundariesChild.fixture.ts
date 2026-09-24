/* Read-only restart against the actual public Core factory; no replacement runtime or SQLite writer. */
import assert from "node:assert/strict";
import { createCoreAuthority } from "@zcode/services/node";
import {
  IProjectCatalogRpcService,
  IWorkspaceHierarchyService,
  IZCodeAgentService,
} from "@zcode/services";
import { DatabaseSync } from "node:sqlite";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

let core: Awaited<ReturnType<typeof createCoreAuthority>> | undefined;
try {
  core = await createCoreAuthority({
    installationId: "native-mount-fixture",
    profileRoot: process.env.ZCODE_DATA_BASE_DIR!,
    zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
  });
  await core.reconcileBeforeAdmission();
  const hierarchy = core.services.get(IWorkspaceHierarchyService);
  const catalog = core.services.get(IProjectCatalogRpcService);
  const ids = JSON.parse(process.env.CORE_NATIVE_IDS!) as [string, string];
  const snapshot = await catalog.sidebarSnapshot();
  const healthy = await hierarchy.resolveOwner({
    targetId: "native-mount-fixture",
    workspaceId: "workspace",
    sessionId: ids[1],
  });
  const damaged = await hierarchy.resolveOwner({
    targetId: "native-mount-fixture",
    workspaceId: "workspace",
    sessionId: ids[0],
  });
  if (process.env.CORE_NATIVE_VERIFY_INPUT === "1") {
    // 中文：选项完整且 Registry 有效、但与原命令选择不同；不能把它当缺失 options 的弱冲突。
    await assert.rejects(
      hierarchy.createAgent({
        workspaceId: "workspace",
        harnessId: "zcode",
        commandId: "native-create-1",
        modelBinding: {
          kind: "host-managed",
          selection: {
            providerId: "fixture",
            modelId: "fixture-other",
            options: { reasoningLevel: "off" },
          },
        },
      }),
      /native-create-intent-conflict/,
    );
    const repo = await realpath(join(process.env.ZCODE_DATA_BASE_DIR!, "real-repo"));
    const db = new DatabaseSync(process.env.ZCODE_SESSION_DB_PATH!, { readOnly: true });
    const service = core.services.get(IZCodeAgentService);
    const facts: unknown[] = [];
    for (const [index, id] of ids.entries()) {
      const receipt = db
        .prepare(
          "select session_id as id, workspace_scope as scope, status from native_create_receipt where command_id = ?",
        )
        .get(`native-create-${index + 1}`) as
        | { id: string; scope: string; status: string }
        | undefined;
      const row = db
        .prepare(
          "select data from session_entry where id = ? and session_id = ? and type = 'native/create_config'",
        )
        .get(`native-create-config:native-create-${index + 1}`, id) as { data: string } | undefined;
      const fact =
        row && (JSON.parse(row.data) as { selection: { modelId: string }; execution: unknown });
      if (
        receipt?.id !== id ||
        receipt.scope !== repo ||
        receipt.status !== "completed" ||
        JSON.stringify(fact?.execution) !== JSON.stringify({ mode: "build", planEnabled: false })
      )
        throw new Error(`original ${index} mode or execution not certified`);
      facts.push(fact?.selection);
      const subscription = await service.subscribeConversationV4({
        workspacePath: repo,
        workspaceIdentity: repo,
        sessionId: id,
        visibility: "foreground",
      });
      const ack = await service.sendConversationCommandV4({
        workspacePath: repo,
        workspaceIdentity: repo,
        envelope: {
          commandId: `boundary-input-${index}`,
          clientId: "boundary-fixture",
          sessionId: id,
          type: "sendText",
          issuedAt: Date.now(),
          payload: { text: `proof-original-${index}` },
        },
      });
      if (ack.status !== "accepted") throw new Error(`input ${index} not accepted`);
      let terminal = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        const current = await service.readSession({
          workspacePath: repo,
          workspaceIdentity: repo,
          sessionId: id,
        });
        if (current.session.status === "error") throw new Error(`turn ${index} errored`);
        if (
          current.session.status === "completed" ||
          (current.session.status === "idle" &&
            current.messages.some(
              (row) => row.info.role === "assistant" && row.info.time.completed !== undefined,
            ))
        ) {
          terminal = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
      if (!terminal) throw new Error(`turn ${index} did not finish`);
      await service.unsubscribeConversationV4({
        workspacePath: repo,
        workspaceIdentity: repo,
        subscriptionId: subscription.ack.subscriptionId,
      });
    }
    db.close();
    process.send?.({ type: "input", facts });
  } else {
    process.send?.({
      type: "read",
      sessionIds: snapshot.sessions.map((row) => row.session.id),
      healthy:
        healthy?.kind === "native" && healthy.originalSessionId === ids[1] && !healthy.historyOnly,
      damaged: damaged === undefined,
    });
  }
} catch (error) {
  process.send?.({ type: "error", reason: String(error) });
  process.exitCode = 1;
} finally {
  await core?.dispose();
  process.disconnect?.();
}
