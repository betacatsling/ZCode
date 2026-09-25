import assert from "node:assert/strict";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import {
  SESSION_ENTRY_EXECUTION_STATE,
  SESSION_ENTRY_MODEL_SELECTION,
  type MessageInfo,
  type MessagePart,
  type ProjectId,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";

const git = promisify(execFile);
const LEGACY_SESSION_ID = "native-legacy-core-original";
const FIXTURE_SELECTION = {
  providerId: "fixture",
  modelId: "fixture-model",
  options: { reasoningLevel: "off" },
};
const CORE_FIXTURE = fileURLToPath(
  new URL(
    "../../../../../packages/zcode-server-cli/src/server-core/nativeLegacyProductCore.fixture.ts",
    import.meta.url,
  ),
);

test(
  "public Core joins verified legacy mapping and preserves a real V4 side-session lineage",
  { timeout: 90000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "native-legacy-core-product-"));
    let child: ChildProcess | undefined;
    t.after(async () => {
      await stopChild(child);
      await rm(root, { recursive: true, force: true });
    });
    const cwd = join(root, "existing-worktree");
    const dbPath = join(root, "configured-session.sqlite");
    const builtinPath = join(root, "builtin-provider-config.json");
    await mkdir(cwd);
    await git("git", ["init", "-q", cwd]);
    await writeFile(join(cwd, "README.md"), "isolated legacy fixture\n");
    await git("git", ["-C", cwd, "add", "README.md"]);
    await git("git", [
      "-C",
      cwd,
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "user.name=fixture",
      "commit",
      "-qm",
      "initial",
    ]);
    const canonicalCwd = await realpath(cwd);
    await writeFile(
      builtinPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 0,
        config: {
          providerConfigRules: { templateRules: [], providerRules: [] },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
    );

    const store = await SqliteSessionStore.openStartup({ dbPath });
    try {
      const now = Date.now();
      await store.createSession({
        id: LEGACY_SESSION_ID as SessionId,
        projectID: "legacy-project" as ProjectId,
        workspaceID: canonicalCwd as WorkspaceId,
        slug: "legacy-core-session",
        directory: canonicalCwd,
        path: canonicalCwd,
        title: "Imported custom title",
        titleSource: "custom",
        version: "legacy-fixture",
        permission: { mode: "yolo", allow: [{ toolName: "Read" }], deny: [{ toolName: "Bash" }] },
        time: { created: now, updated: now },
      });
      await store.saveSessionEntry({
        id: `${LEGACY_SESSION_ID}:selection`,
        sessionID: LEGACY_SESSION_ID as SessionId,
        type: SESSION_ENTRY_MODEL_SELECTION,
        touchSession: false,
        time: { created: now, updated: now },
        data: FIXTURE_SELECTION,
      });
      await store.saveSessionEntry({
        id: `${LEGACY_SESSION_ID}:execution`,
        sessionID: LEGACY_SESSION_ID as SessionId,
        type: SESSION_ENTRY_EXECUTION_STATE,
        touchSession: false,
        time: { created: now, updated: now },
        data: { mode: "yolo", planEnabled: false },
      });
      const user = makeMessage("legacy-core-user", LEGACY_SESSION_ID, canonicalCwd, now);
      const assistant = makeMessage(
        "legacy-core-assistant",
        LEGACY_SESSION_ID,
        canonicalCwd,
        now + 1,
        user.id,
        "assistant",
      );
      await store.saveMessage(user);
      await store.savePart(makePart("legacy-core-user-part", user.id, "Legacy seed"));
      await store.saveMessage(assistant);
      await store.savePart(makePart("legacy-core-assistant-part", assistant.id, "Legacy answer"));
    } finally {
      store.close();
    }

    child = launchCoreFixture({ root, cwd, dbPath, builtinPath });
    const result = await waitForCoreResult(child, t.signal);
    assert.equal(result.unmappedOwner, null, "Core history must not infer a legacy mapping");
    assert.equal(result.indexedOriginalId, LEGACY_SESSION_ID);
    assert.equal(result.mappingCount, 1);
    assert.equal(result.joinedOwner.kind, "native");
    assert.equal(result.joinedOwner.originalSessionId, LEGACY_SESSION_ID);
    assert.equal(result.joinedOwner.historyOnly, false);
    assert.equal(result.initialCommandStatus, "accepted");
    assert.equal(result.followupCommandStatus, "accepted");
    assert.equal(result.followupTerminal, true);
    assert.equal(result.runningCommandStatus, "accepted");
    assert.equal(result.queuedCommandStatus, "accepted");
    assert.equal(result.queuedRetryStatus, "duplicate");
    assert.equal(result.reconnectSubscription, true);
    assert.equal(result.sideSessionStatus, "accepted");
    assert.notEqual(result.sideSessionId, LEGACY_SESSION_ID);
    assert.equal(result.sideSessionParentId, LEGACY_SESSION_ID);
    assert.equal(result.duplicateSideSessionStatus, "duplicate");
    assert.ok(result.forkTarget.rowId >= 0);
    assert.ok(result.forkTarget.entityId.length > 0);
    assert.ok(result.forkRevision >= 0);
    assert.equal(result.forkColdId, result.forkedId);
    assert.equal(result.editStatus, "accepted");
    assert.equal(result.retryStatus, "accepted");
    assert.equal(result.stalePair.status, "stale");
    assert.equal(result.stalePair.reasonCode, "proto.staleTarget");
    assert.equal(result.staleRevision.status, "stale");
    assert.equal(result.staleRevision.reasonCode, "proto.staleRevision");
    assert.equal(result.permissionDenial.status, "accepted");
    assert.equal(result.permissionDenial.noEffect, true);
    assert.equal(result.permissionApproval.status, "accepted");
    assert.equal(result.permissionApproval.effectBytes, "approved legacy write\n");
    assert.equal(result.permissionApproval.continuedWithToolResult, true);
    assert.equal(result.permissionApproval.staleStatus, "accepted");
    assert.equal(result.heldStop.status, "accepted");
    assert.equal(result.heldStop.interrupted, true);
    assert.equal(result.replayable.profile, "replayable");
    assert.equal(result.replayable.initialMode, "snapshot");
    assert.equal(result.replayable.resumeMode, "resume");
    assert.ok(result.replayable.resumeToSeq > result.replayable.resumeFromSeq);
    assert.equal(result.replayable.replayedStopTurn, true);
    assert.equal(result.replayable.snapshotMode, "snapshot");
    assert.equal(result.replayable.sameSubscription, true);
    assert.equal(result.replayable.modelCallsUnchanged, true);
    assert.equal(result.rewoundInputsAbsent, true);
    assert.equal(result.editContextPreserved, true);
    assert.equal(result.heldStopRequestRecorded, true);
    assert.ok(result.editTarget.entityId);
    assert.ok(result.retryTarget.entityId);
    assert.notEqual(result.editTarget.rowId, result.retryTarget.rowId);
    assert.ok(result.coldVisibleInputs.some((text) => text.includes(result.editedText)));
    assert.ok(
      !result.coldVisibleInputs.some((text) => text.includes("queued parent input")),
      "cold active branch hides rewound turn",
    );
    assert.deepEqual(result.modelCalls, [
      "fixture-model",
      "fixture-model",
      "fixture-model",
      "fixture-model",
      "fixture-other",
      "fixture-model",
      "fixture-model",
      "fixture-model",
      "fixture-model",
      "fixture-model",
      "fixture-model",
      "fixture-model",
    ]);
    assert.deepEqual(result.modelRequestContainsInput, [true, true, true, true, true, true, true]);
    assert.ok(result.workerPids.length >= 2, "fixture must prove it owned real CLI workers");
    for (const pid of result.workerPids)
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    assert.equal(result.coldOwner.originalSessionId, LEGACY_SESSION_ID);
    assert.equal(result.coldOwner.historyOnly, false);
    assert.equal(result.coldResumeIds.includes(LEGACY_SESSION_ID), true);
    assert.equal(result.coldResumeIds.includes(result.sideSessionId), true);

    const reopened = await SqliteSessionStore.openStartup({ dbPath });
    try {
      const parent = await reopened.getSession(LEGACY_SESSION_ID as SessionId);
      const side = await reopened.getSession(result.sideSessionId as SessionId);
      const forked = await reopened.getSession(result.forkedId as SessionId);
      assert.ok(parent);
      assert.ok(side);
      assert.ok(forked);
      assert.equal(forked.parentID, LEGACY_SESSION_ID);
      assert.equal(parent.title, "Imported custom title");
      assert.equal(parent.parentID, undefined);
      assert.equal(side.parentID, LEGACY_SESSION_ID);
      assert.deepEqual(parent.permission, {
        mode: "yolo",
        allow: [{ toolName: "Read" }],
        deny: [{ toolName: "Bash" }],
      });
      const parentSelection = await reopened.sessionEntries({
        sessionID: LEGACY_SESSION_ID as SessionId,
        type: SESSION_ENTRY_MODEL_SELECTION,
      });
      const parentExecution = await reopened.sessionEntries({
        sessionID: LEGACY_SESSION_ID as SessionId,
        type: SESSION_ENTRY_EXECUTION_STATE,
      });
      const sideSelection = await reopened.sessionEntries({
        sessionID: result.sideSessionId as SessionId,
        type: SESSION_ENTRY_MODEL_SELECTION,
      });
      const forkSelection = await reopened.sessionEntries({
        sessionID: result.forkedId as SessionId,
        type: SESSION_ENTRY_MODEL_SELECTION,
      });
      assert.deepEqual(parentSelection.at(-1)?.data, FIXTURE_SELECTION);
      assert.deepEqual(forkSelection.at(-1)?.data, FIXTURE_SELECTION);
      // permission 规则仍保持迁移 seed 的 yolo/allow/deny（上面已断言）；执行态 mode
      // 是 operations 阶段通过真实 setPermissionMode 命令切到 build 的持久化结果，
      // 冷重启后读到 build 恰好证明该命令走了真实 CLI 持久化路径。
      assert.deepEqual(parentExecution.at(-1)?.data, { mode: "build", planEnabled: false });
      const childSelection = sideSelection.at(-1)?.data as { modelId?: unknown } | undefined;
      assert.equal(childSelection?.modelId, "fixture-other");
      const parentMessages = await reopened.messages({ sessionID: LEGACY_SESSION_ID as SessionId });
      const sideMessages = await reopened.messages({
        sessionID: result.sideSessionId as SessionId,
      });
      const forkMessages = await reopened.messages({ sessionID: result.forkedId as SessionId });
      const parentText = parentMessages
        .flatMap(({ parts }) => parts)
        .map((part) => (part.type === "text" ? part.text : ""));
      const sideText = sideMessages
        .flatMap(({ parts }) => parts)
        .map((part) => (part.type === "text" ? part.text : ""));
      assert.ok(parentMessages.some(({ info }) => info.id === "legacy-core-user"));
      assert.ok(parentMessages.some(({ info }) => info.id === "legacy-core-assistant"));
      assert.ok(parentText.some((text) => text.includes("legacy core followup")));
      assert.ok(parentText.some((text) => text.includes("held parent input")));
      assert.ok(parentText.some((text) => text.includes(result.editedText)));
      // SQLite retains historical branch messages; only the cold public projection defines visible lineage.
      assert.ok(!parentText.some((text) => text.includes("selection side child input")));
      assert.ok(sideText.some((text) => text.includes("selection side child input")));
      assert.ok(
        sideText.some((text) => text.includes("Legacy seed")),
        "fork copies committed source context",
      );
      assert.ok(
        sideText.some((text) => text.includes("Legacy answer")),
        "fork preserves source answer",
      );
      const forkText = forkMessages
        .flatMap(({ parts }) => parts)
        .map((part) => (part.type === "text" ? part.text : ""));
      assert.ok(forkText.some((text) => text.includes("Legacy seed")));
      assert.ok(forkText.some((text) => text.includes("queued parent input")));
      assert.ok(!forkText.some((text) => text.includes("selection side child input")));
      const sessionRows = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = sessionRows
          .prepare("SELECT id, parent_id FROM session ORDER BY id")
          .all() as Array<{ id: string; parent_id: string | null }>;
        assert.equal(rows.length, 3, "duplicate fork/side commands must not allocate another ID");
        const childRow = rows.find(({ id }) => id === result.sideSessionId);
        assert.equal(childRow?.id, result.sideSessionId);
        assert.equal(childRow?.parent_id, LEGACY_SESSION_ID);
      } finally {
        sessionRows.close();
      }
    } finally {
      reopened.close();
    }
  },
);

function launchCoreFixture(input: {
  root: string;
  cwd: string;
  dbPath: string;
  builtinPath: string;
}): ChildProcess {
  const cliMain = join(process.cwd(), "apps/zcode-cli/packages/cli/src/main.ts");
  return fork(CORE_FIXTURE, [], {
    cwd: process.cwd(),
    execArgv: ["--import", "tsx"],
    env: {
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: "--max-old-space-size=2048",
      HOME: input.root,
      XDG_CONFIG_HOME: input.root,
      ZCODE_DATA_BASE_DIR: input.root,
      ZCODE_SESSION_DB_PATH: input.dbPath,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: input.builtinPath,
      ZCODE_AGENT_SERVER_COMMAND: process.execPath,
      ZCODE_AGENT_SERVER_ARGS_JSON: JSON.stringify([
        "--import",
        "tsx",
        cliMain,
        "app-server",
        "--stdio",
      ]),
      ZCODE_AGENT_SERVER_REQUIRES_STORAGE_STARTUP: "1",
      ZCODE_MULTI_HARNESS_ENABLED: "1",
      ZCODE_TELEMETRY_ENABLED: "false",
      CORE_NATIVE_LEGACY_FIXTURE_CWD: input.cwd,
      CORE_NATIVE_LEGACY_FIXTURE_ROOT: input.root,
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
}

async function waitForCoreResult(child: ChildProcess, signal: AbortSignal): Promise<CoreResult> {
  assert.ok(child.stderr);
  let stderrHead = "";
  let stderrTail = "";
  child.stderr.on("data", (chunk: Buffer) => {
    // 失败信息可能出现在头部（fixture catch 的 fixture-error）或尾部
    // （unhandled rejection / 清理日志），头尾各留一段窗口。
    stderrHead = (stderrHead + chunk.toString()).slice(0, 4000);
    stderrTail = (stderrTail + chunk.toString()).slice(-8000);
  });
  const stderr = () =>
    stderrTail.includes(stderrHead) ? stderrTail : `${stderrHead}\n…\n${stderrTail}`;
  const message = await new Promise<CoreResult>((resolve, reject) => {
    const timer = setTimeout(
      () => settle(new Error(`Core legacy fixture timeout: ${stderr()}`)),
      80000,
    );
    const onAbort = () => settle(new Error("Core legacy fixture aborted"));
    const onMessage = (value: unknown) => {
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.kind === "result") settle(undefined, record as unknown as CoreResult);
      else if (record.kind === "error")
        settle(new Error(`Core legacy fixture failed: ${String(record.message)} ${stderr()}`));
    };
    const onExit = (code: number | null, signalCode: NodeJS.Signals | null) => {
      settle(new Error(`Core legacy fixture exited ${code}/${signalCode}: ${stderr()}`));
    };
    function settle(error?: Error, value?: CoreResult) {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value!);
    }
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("message", onMessage);
    child.once("exit", onExit);
    if (signal.aborted) onAbort();
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Core fixture did not exit after result")),
      5000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Core fixture exited ${code}: ${stderr()}`));
    });
  });
  return message;
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  if (
    await Promise.race([
      exited.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 1500)),
    ])
  )
    return;
  child.kill("SIGKILL");
  await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Core fixture child did not reap")), 1500),
    ),
  ]);
}

interface CoreResult {
  unmappedOwner: unknown;
  indexedOriginalId: string;
  mappingCount: number;
  joinedOwner: { kind: string; originalSessionId: string; historyOnly: boolean };
  initialCommandStatus: string;
  followupCommandStatus: string;
  followupTerminal: boolean;
  runningCommandStatus: string;
  queuedCommandStatus: string;
  queuedRetryStatus: string;
  reconnectSubscription: boolean;
  sideSessionStatus: string;
  sideSessionId: string;
  sideSessionParentId: string;
  duplicateSideSessionStatus: string;
  forkedId: string;
  forkTarget: { rowId: number; entityId: string };
  forkRevision: number;
  forkColdId: string;
  editTarget: { rowId: number; entityId: string };
  retryTarget: { rowId: number; entityId: string };
  editStatus: string;
  retryStatus: string;
  stalePair: { status: string; reasonCode?: string };
  staleRevision: { status: string; reasonCode?: string };
  permissionDenial: { status: string; noEffect: boolean };
  permissionApproval: {
    status: string;
    effectBytes: string;
    continuedWithToolResult: boolean;
    staleStatus: string;
  };
  heldStop: { status: string; interrupted: boolean; foregroundExecutionId: string | null };
  replayable: {
    profile: string;
    initialMode: string;
    resumeMode: string;
    resumeFromSeq: number;
    resumeToSeq: number;
    replayedStopTurn: boolean;
    snapshotMode: string;
    sameSubscription: boolean;
    modelCallsUnchanged: boolean;
  };
  rewoundInputsAbsent: boolean;
  editContextPreserved: boolean;
  heldStopRequestRecorded: boolean;
  editedText: string;
  coldVisibleInputs: string[];
  modelCalls: string[];
  modelRequestContainsInput: boolean[];
  workerPids: number[];
  coldOwner: { originalSessionId: string; historyOnly: boolean };
  coldResumeIds: string[];
}

function makeMessage(
  id: string,
  sessionId: string,
  cwd: string,
  created: number,
  parentId?: MessageInfo["id"],
  role: "user" | "assistant" = "user",
): MessageInfo {
  return {
    id: id as MessageInfo["id"],
    sessionID: sessionId as SessionId,
    role,
    time: { created, ...(role === "assistant" ? { completed: created + 1 } : {}) },
    ...(parentId ? { parentID: parentId } : {}),
    mode: "yolo",
    agent: "fixture-model",
    path: { cwd, root: cwd },
    ...(role === "assistant"
      ? { cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } }
      : {}),
  } as MessageInfo;
}

function makePart(id: string, messageId: MessageInfo["id"], text: string): MessagePart {
  return {
    id: id as MessagePart["id"],
    sessionID: LEGACY_SESSION_ID as SessionId,
    messageID: messageId,
    type: "text",
    text,
  };
}
