import { join } from "node:path";
import { ServiceCollection } from "@zcode/services";
import {
  CommandJournal,
  disposeServiceResourcesAndWait,
  getAppConfigDir,
  ProfileFileOwner,
  TargetAuthorityStore,
} from "@zcode/services/node";
import { runServerCore } from "../server-core/core.js";

/**
 * 真实受管 Core 替身：用真实的 ProfileFileOwner/TargetAuthorityStore 取得与生产 Core
 * 相同的三类 occupancy marker（profile authority、catalog、target lease）。SIGKILL 后
 * marker 全部残留；replacement Core 只有经可信 Supervisor 逐锁证明后才能再次取得。
 * 额外的 journal 命令提供真实 CommandJournal 持久化，用来证明 crash 后 accepted-but-
 * unknown 命令保持 execution-unknown 且不会被重放。
 */
const generation = Number(process.argv[2] ?? 0);
const journalRoot = process.env.ZCODE_FIXTURE_JOURNAL_ROOT ?? "";
const journalIdentity = {
  targetId: "fixture-target",
  workspaceIdentity: "fixture-workspace",
  harnessId: "mock",
  hostSessionId: "fixture-host-session",
  runtimeEpoch: "fixture-runtime-epoch",
};

let profileOwner: ProfileFileOwner | undefined;
let catalogOwner: ProfileFileOwner | undefined;
let targetStore: TargetAuthorityStore | undefined;

void runServerCore(generation, async () => {
  const configRoot = getAppConfigDir();
  profileOwner = await ProfileFileOwner.open(join(configRoot, "core-authority.json"));
  catalogOwner = await ProfileFileOwner.open(
    join(configRoot, "workspace-hierarchy", "profile", "catalog.json"),
  );
  targetStore = await TargetAuthorityStore.open(
    join(configRoot, "workspace-hierarchy", "target"),
    journalIdentity.targetId,
  );
  const services = new ServiceCollection();
  return {
    services,
    async dispose() {
      await disposeServiceResourcesAndWait(services);
      await targetStore?.close().catch(() => undefined);
      await catalogOwner?.close().catch(() => undefined);
      await profileOwner?.close().catch(() => undefined);
    },
    async reconcileBeforeAdmission() {},
    maintenance: {
      async freezeAdmissions() {
        return {
          async release() {},
        };
      },
      async readActivity() {
        return {
          native: { running: 0, waiting: 0, uncertain: 0 },
          external: { running: 0, waiting: 0, uncertain: 0 },
        };
      },
    },
  };
}).catch((error: unknown) => {
  process.send?.({ type: "fatal-fixture", error: String(error) }, () => process.exit(1));
});

process.on("message", (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const command = raw as { command?: string; commandId?: string };
  if (command.command === "fixture-journal-accept" && command.commandId) {
    const commandId = command.commandId;
    void (async () => {
      const journal = await CommandJournal.open(journalRoot, journalIdentity);
      try {
        await journal.accept({
          type: "send",
          commandId,
          hostSessionId: journalIdentity.hostSessionId,
          turnId: `turn-${commandId}`,
          text: "fixture prompt",
        });
      } finally {
        await journal.close();
      }
    })().then(
      () => process.send?.({ type: "fixture-journal-accepted", commandId }),
      (error: unknown) =>
        process.send?.({ type: "fixture-journal-failed", commandId, error: String(error) }),
    );
  } else if (command.command === "fixture-journal-status" && command.commandId) {
    const commandId = command.commandId;
    void CommandJournal.queryHistory(journalRoot, journalIdentity, commandId).then(
      (receipt) =>
        process.send?.({
          type: "fixture-journal-status",
          commandId,
          status: receipt?.status ?? "missing",
        }),
      (error: unknown) =>
        process.send?.({
          type: "fixture-journal-status",
          commandId,
          status: "error",
          error: String(error),
        }),
    );
  }
});
