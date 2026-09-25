import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { V4_METHODS } from "@zcode/shared/zcode-protocol-v4";
import { launchNativeLegacyProductCli } from "./nativeLegacyProduct-fixture.js";

const LEGACY_SESSION_ID = "native-legacy-original-session";
const FIXTURE_SELECTION = {
  providerId: "fixture",
  modelId: "fixture-model",
  options: { reasoningLevel: "off" },
};

test(
  "public V4 first activation reuses legacy SQLite identity/config and hides model-only history",
  { timeout: 45000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "native-legacy-product-"));
    const cwd = join(root, "existing-worktree");
    const dbPath = join(root, "configured-session.sqlite");
    await mkdir(cwd);
    const store = await SqliteSessionStore.openStartup({ dbPath });
    const now = Date.now();
    try {
      await store.createSession({
        id: LEGACY_SESSION_ID as SessionId,
        projectID: "legacy-project" as ProjectId,
        workspaceID: cwd as WorkspaceId,
        slug: "legacy-session",
        directory: cwd,
        path: cwd,
        title: "Imported custom title",
        titleSource: "custom",
        version: "legacy-fixture",
        permission: { mode: "yolo", allow: [{ toolName: "Read" }], deny: [{ toolName: "Bash" }] },
        time: { created: now, updated: now },
      });
      await store.saveSessionEntry({
        id: `${LEGACY_SESSION_ID}:legacy-model-selection`,
        sessionID: LEGACY_SESSION_ID as SessionId,
        type: SESSION_ENTRY_MODEL_SELECTION,
        touchSession: false,
        time: { created: now, updated: now },
        data: FIXTURE_SELECTION,
      });
      await store.saveSessionEntry({
        id: `${LEGACY_SESSION_ID}:legacy-execution-state`,
        sessionID: LEGACY_SESSION_ID as SessionId,
        type: SESSION_ENTRY_EXECUTION_STATE,
        touchSession: false,
        time: { created: now, updated: now },
        data: { mode: "yolo", planEnabled: false },
      });
      const visibleUser = legacyUserMessage("legacy-visible-user", now, false);
      const hiddenContext = legacyUserMessage("legacy-hidden-context", now + 1, true);
      const assistant: MessageInfo = {
        id: "legacy-visible-assistant" as MessageInfo["id"],
        sessionID: LEGACY_SESSION_ID as SessionId,
        role: "assistant",
        time: { created: now + 2, completed: now + 3 },
        parentID: visibleUser.id,
        mode: "yolo",
        agent: "fixture-model",
        path: { cwd, root: cwd },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
      };
      await store.saveMessage(visibleUser);
      await store.savePart(
        legacyTextPart("legacy-visible-user-part", visibleUser.id, "Legacy visible query"),
      );
      await store.saveMessage(hiddenContext);
      await store.savePart(
        legacyTextPart("legacy-hidden-context-part", hiddenContext.id, "Legacy model-only context"),
      );
      await store.saveMessage(assistant);
      await store.savePart(
        legacyTextPart("legacy-visible-assistant-part", assistant.id, "Legacy visible response"),
      );
    } finally {
      store.close();
    }

    let cli = await launchNativeLegacyProductCli({ root, cwd, dbPath, signal: t.signal });
    let failed = false;
    try {
      await cli.nextFrame(
        (frame) => frame.method === "startup/storageState" && frame.params?.phase === "ready",
      );
      const desktopAck = await cli.request(V4_METHODS.conversationSubscribe, {
        topic: `conversation/${LEGACY_SESSION_ID}`,
        connectionId: "legacy-desktop-view",
        clientMode: "desktop-continuous",
      });
      const desktopSubscriptionId = subscriptionId(desktopAck);
      const desktopSnapshot = await cli.nextFrame((frame) =>
        isSnapshotFrame(frame, LEGACY_SESSION_ID, desktopSubscriptionId),
      );
      assert.ok(desktopSnapshot.params?.frame);
      const snapshot = (desktopSnapshot.params.frame as Record<string, unknown>).payload as {
        snapshot: {
          sessionId: string;
          meta: { title: string; titleSource: string };
          config: { mode: string; modelSelection?: { providerId: string; modelId: string } };
          rows: { window: Array<{ kind: string; text?: string }> };
        };
      };
      assert.equal(snapshot.snapshot.sessionId, LEGACY_SESSION_ID);
      assert.equal(snapshot.snapshot.config.mode, "yolo");
      assert.deepEqual(snapshot.snapshot.config.modelSelection, FIXTURE_SELECTION);
      assert.equal(snapshot.snapshot.meta.title, "Imported custom title");
      assert.equal(snapshot.snapshot.meta.titleSource, "custom");
      const visibleText = snapshot.snapshot.rows.window.map((row) => row.text ?? "").join("\n");
      assert.match(visibleText, /Legacy visible query/);
      assert.match(visibleText, /Legacy visible response/);
      assert.doesNotMatch(visibleText, /Legacy model-only context/);

      const database = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = database
          .prepare("SELECT id, directory, workspace_id, title, permission FROM session ORDER BY id")
          .all() as Array<{
          id: string;
          directory: string;
          workspace_id: string | null;
          title: string;
          permission: string;
        }>;
        assert.equal(rows.length, 1, "activation must not allocate a replacement native session");
        assert.equal(rows[0]?.id, LEGACY_SESSION_ID);
        assert.equal(rows[0]?.directory, cwd);
        assert.equal(rows[0]?.workspace_id, cwd);
        assert.equal(rows[0]?.title, "Imported custom title");
        const persisted = JSON.parse(rows[0]!.permission) as { mode?: string; deny?: unknown[] };
        assert.equal(persisted.mode, "yolo");
        assert.equal(persisted.deny?.length, 1);
      } finally {
        database.close();
      }

      const mobileAck = await cli.request(V4_METHODS.conversationSubscribe, {
        topic: `conversation/${LEGACY_SESSION_ID}`,
        connectionId: "legacy-mobile-view",
        clientMode: "web-remote-replayable",
      });
      const mobileSubscriptionId = subscriptionId(mobileAck);
      await cli.nextFrame((frame) =>
        isSnapshotFrame(frame, LEGACY_SESSION_ID, mobileSubscriptionId),
      );
      assert.equal(
        cli.upstreamRequests(),
        0,
        "opening either view must not invoke the Model executor",
      );

      const rename = await cli.request(V4_METHODS.command, {
        commandId: "legacy-rename-once",
        clientId: "legacy-desktop-view",
        sessionId: LEGACY_SESSION_ID,
        type: "renameSession",
        issuedAt: 1,
        payload: { title: "Renamed original session" },
      });
      assert.equal(
        rename.result?.status,
        "accepted",
        JSON.stringify(rename.error ?? rename.result),
      );
      const renamedAck = await cli.request(V4_METHODS.conversationSubscribe, {
        topic: `conversation/${LEGACY_SESSION_ID}`,
        connectionId: "legacy-reopened-view",
        clientMode: "desktop-continuous",
      });
      const renamedFrame = await cli.nextFrame((frame) =>
        isSnapshotFrame(frame, LEGACY_SESSION_ID, subscriptionId(renamedAck)),
      );
      assert.ok(renamedFrame.params?.frame);
      const renamed = (
        renamedFrame.params.frame as {
          payload: { snapshot: { meta: { title: string; titleSource: string } } };
        }
      ).payload.snapshot;
      assert.deepEqual(renamed.meta, { title: "Renamed original session", titleSource: "custom" });
      const persistedTitle = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const row = persistedTitle.prepare("SELECT id, title, title_source FROM session").get() as {
          id: string;
          title: string;
          title_source: string;
        };
        assert.equal(row.id, LEGACY_SESSION_ID);
        assert.equal(row.title, "Renamed original session");
        assert.equal(row.title_source, "custom");
      } finally {
        persistedTitle.close();
      }
      assert.equal(
        cli.upstreamRequests(),
        0,
        "renaming/reopening must not invoke the Model executor",
      );
      await cli.close();
      cli = await launchNativeLegacyProductCli({ root, cwd, dbPath, signal: t.signal });
      await cli.nextFrame(
        (frame) => frame.method === "startup/storageState" && frame.params?.phase === "ready",
      );
      const coldAck = await cli.request(V4_METHODS.conversationSubscribe, {
        topic: `conversation/${LEGACY_SESSION_ID}`,
        connectionId: "legacy-cold-view",
        clientMode: "web-remote-replayable",
      });
      const coldFrame = await cli.nextFrame((frame) =>
        isSnapshotFrame(frame, LEGACY_SESSION_ID, subscriptionId(coldAck)),
      );
      assert.ok(coldFrame.params?.frame);
      const coldSnapshot = (
        coldFrame.params.frame as {
          payload: {
            snapshot: { sessionId: string; meta: { title: string; titleSource: string } };
          };
        }
      ).payload.snapshot;
      assert.equal(coldSnapshot.sessionId, LEGACY_SESSION_ID);
      assert.deepEqual(coldSnapshot.meta, {
        title: "Renamed original session",
        titleSource: "custom",
      });
      assert.equal(cli.upstreamRequests(), 0, "cold reopen must not invoke the Model executor");
      const followup = {
        commandId: "legacy-followup-once",
        clientId: "legacy-desktop-view",
        sessionId: LEGACY_SESSION_ID,
        type: "sendText",
        issuedAt: 2,
        payload: { text: "Disposable legacy follow-up" },
      };
      const sent = await cli.request(V4_METHODS.command, followup);
      assert.equal(sent.result?.status, "accepted", JSON.stringify(sent.error ?? sent.result));
      const terminal = await cli.nextFrame((frame) => {
        const payload = (
          frame.params?.frame as
            | {
                topic?: string;
                payload?: {
                  deltas?: Array<{
                    row?: { kind?: string; state?: string; sourceCommandId?: string };
                  }>;
                };
              }
            | undefined
        )?.payload;
        return (
          frame.method === "v4/conversation/frame" &&
          payload?.deltas?.some(
            (delta) =>
              delta.row?.kind === "turnHeader" &&
              delta.row.sourceCommandId === followup.commandId &&
              delta.row.state === "completedSuccess",
          ) === true
        );
      });
      assert.ok(terminal);
      const reply = await cli.nextFrame((frame) => {
        const payload = (
          frame.params?.frame as
            | {
                payload?: {
                  deltas?: Array<{ row?: { kind?: string; state?: string; text?: string } }>;
                };
              }
            | undefined
        )?.payload;
        return (
          frame.method === "v4/conversation/frame" &&
          payload?.deltas?.some(
            (delta) =>
              delta.row?.kind === "assistantText" &&
              delta.row.state === "complete" &&
              delta.row.text?.includes("native legacy fixture response"),
          ) === true
        );
      });
      assert.ok(reply);
      assert.equal(cli.upstreamRequests(), 1);
      const duplicate = await cli.request(V4_METHODS.command, followup);
      assert.equal(
        duplicate.result?.status,
        "duplicate",
        JSON.stringify(duplicate.error ?? duplicate.result),
      );
      assert.equal(cli.upstreamRequests(), 1);
      const dbAfter = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (dbAfter.prepare("SELECT count(*) AS count FROM session").get() as { count: number })
            .count,
          1,
        );
        const row = dbAfter
          .prepare("SELECT title, title_source FROM session WHERE id = ?")
          .get(LEGACY_SESSION_ID) as { title: string; title_source: string };
        assert.equal(
          row.title,
          "Renamed original session",
          "automatic title must not overwrite the custom title",
        );
        assert.equal(row.title_source, "custom");
      } finally {
        dbAfter.close();
      }
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      try {
        if (failed) await cli.close().catch(() => {});
        else await cli.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

test(
  "nativeLegacyProduct fixture abort reaps owned CLI before deleting its isolated root",
  { timeout: 10000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "native-legacy-abort-"));
    const cwd = join(root, "worktree");
    const dbPath = join(root, "session.sqlite");
    await mkdir(cwd);
    const controller = new AbortController();
    let cli: Awaited<ReturnType<typeof launchNativeLegacyProductCli>> | undefined;
    try {
      cli = await launchNativeLegacyProductCli({ root, cwd, dbPath, signal: controller.signal });
      await cli.nextFrame(
        (frame) => frame.method === "startup/storageState" && frame.params?.phase === "ready",
      );
      controller.abort();
      await cli.close();
      assert.throws(() => process.kill(cli!.childPid, 0), { code: "ESRCH" });
    } finally {
      controller.abort();
      await cli?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

function legacyUserMessage(id: string, created: number, modelOnly: boolean): MessageInfo {
  return {
    id: id as MessageInfo["id"],
    sessionID: LEGACY_SESSION_ID as SessionId,
    role: "user",
    time: { created },
    agent: "fixture-model",
    ...(modelOnly
      ? {
          synthetic: true,
          source: "todo_reminder" as const,
          visibility: "model-only" as const,
          semantics: {
            origin: "agent_runtime" as const,
            kind: "todo_reminder" as const,
            uiVisibility: "hidden" as const,
            providerVisibility: "visible" as const,
            transcriptVisibility: "hidden" as const,
          },
        }
      : { visibility: "user-visible" as const }),
  };
}

function legacyTextPart(id: string, messageId: MessageInfo["id"], text: string): MessagePart {
  return {
    id: id as MessagePart["id"],
    sessionID: LEGACY_SESSION_ID as SessionId,
    messageID: messageId,
    type: "text",
    text,
  };
}

function subscriptionId(frame: { result?: Record<string, unknown> }): string {
  const ack = frame.result?.ack as { subscriptionId?: unknown } | undefined;
  assert.ok(ack && typeof ack.subscriptionId === "string");
  return ack.subscriptionId;
}

function isSnapshotFrame(
  frame: { method?: string; params?: Record<string, unknown> },
  sessionId: string,
  subscriptionId: string,
): boolean {
  const topicFrame = frame.params?.frame as
    | { topic?: string; subscriptionId?: string; payload?: { kind?: string } }
    | undefined;
  return (
    frame.method === "v4/conversation/frame" &&
    topicFrame?.topic === `conversation/${sessionId}` &&
    topicFrame.subscriptionId === subscriptionId &&
    topicFrame.payload?.kind === "snapshot"
  );
}
