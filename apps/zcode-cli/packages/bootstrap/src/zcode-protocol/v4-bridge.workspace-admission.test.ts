import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteSessionStore } from "@zcode/adapters/storage";
import {
  SESSION_ENTRY_WORKSPACE_GENERATION,
  type MessageId,
  type PartId,
  type ProjectId,
  type SessionId,
  type WorkspaceId,
} from "@zcode/contracts";
import { managedWorkspaceSessionAssociationSchema } from "@zcode/shared/agent-host";
import {
  atomicWritePrivateTextFile,
  workspaceAdmissionFenceFilePath,
} from "@zcode/shared/node";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "./server-types.js";
import { acquireWorkspaceAdmissionForV4Command } from "./v4-bridge.js";
import { persistWorkspaceAdmissionGeneration } from "./server-operations.js";

test("a restarted native owner rejects a rebuilt path using the original persisted session generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-native-generation-fence-"));
  const workspacePath = join(root, "recreated worktree");
  const workspaceIdentity = "native-recreated-workspace";
  const workspaceId = "workspace-recreated";
  const targetId = "target-native-generation";
  const oldGeneration = "generation-before-rebuild";
  const currentGeneration = "generation-after-rebuild";
  const sessionId = "native-history-session" as SessionId;
  const databasePath = join(root, "sessions.sqlite");
  let writer: SqliteSessionStore | undefined;
  let restartedStore: SqliteSessionStore | undefined;

  try {
    await mkdir(workspacePath, { recursive: true });
    writer = new SqliteSessionStore({ dbPath: databasePath });
    await writer.createSession({
      id: sessionId,
      projectID: "project-native" as ProjectId,
      workspaceID: workspaceIdentity as WorkspaceId,
      slug: "native-history",
      directory: workspacePath,
      title: "Native history",
      version: "test",
      time: { created: 1, updated: 1 },
    });
    const messageId = "native-history-message" as MessageId;
    await writer.saveMessage({
      id: messageId,
      sessionID: sessionId,
      role: "user",
      time: { created: 2 },
      agent: "native-generation-test",
    });
    await writer.savePart({
      id: "native-history-part" as PartId,
      sessionID: sessionId,
      messageID: messageId,
      type: "text",
      text: "history survives workspace rebuild",
    });
    const record = { app: { sessionId } } as unknown as ZCodeProtocolSessionRecord;
    await persistWorkspaceAdmissionGeneration(
      { deps: { sessionStore: writer } } as unknown as ZCodeProtocolAgentServerContext,
      record,
      oldGeneration,
    );
    writer.close();
    writer = undefined;

    restartedStore = new SqliteSessionStore({ dbPath: databasePath });
    const persisted = await restartedStore.sessionEntries({
      sessionID: sessionId,
      type: SESSION_ENTRY_WORKSPACE_GENERATION,
    });
    assert.equal(
      (persisted[0]?.data as { worktreeGeneration?: string } | undefined)?.worktreeGeneration,
      oldGeneration,
      "the original session generation survives an owner restart",
    );
    assert.equal((await restartedStore.getSession(sessionId))?.directory, workspacePath);
    const history = await restartedStore.messages({ sessionID: sessionId });
    const persistedPart = history[0]?.parts[0];
    assert.equal(
      persistedPart?.type === "text" ? persistedPart.text : undefined,
      "history survives workspace rebuild",
    );

    await rm(workspacePath, { recursive: true, force: true });
    await mkdir(workspacePath, { recursive: true });
    const fencePath = workspaceAdmissionFenceFilePath(
      join(root, "admission"),
      targetId,
      workspaceIdentity,
      workspacePath,
    );
    await atomicWritePrivateTextFile(
      fencePath,
      `${JSON.stringify({
        schemaVersion: 1,
        targetId,
        workspaceId,
        workspaceKey: workspaceIdentity,
        worktreePath: workspacePath,
        worktreeGeneration: currentGeneration,
        lifecycle: "active",
      })}\n`,
    );

    const context = {
      deps: {
        sessionStore: restartedStore,
        cwd: workspacePath,
        env: {
          ZCODE_WORKSPACE_ADMISSION_ROOT: join(root, "admission"),
          ZCODE_WORKSPACE_ADMISSION_TARGET_ID: targetId,
          ZCODE_WORKSPACE_ADMISSION_IDENTITY: workspaceIdentity,
        },
      },
      sessions: new Map(),
    } as unknown as ZCodeProtocolAgentServerContext;
    const envelope = {
      commandId: "send-after-rebuild",
      clientId: "native-generation-test",
      sessionId,
      type: "sendText",
      payload: { text: "must stay history-only" },
      issuedAt: Date.now(),
      workspaceAdmissionGeneration: currentGeneration,
    } as CommandEnvelope;
    const cwdBefore = process.cwd();

    await assert.rejects(
      acquireWorkspaceAdmissionForV4Command(context, envelope),
      /workspace-admission-stale-session-generation/,
    );
    assert.equal((await restartedStore.getSession(sessionId))?.directory, workspacePath);
    assert.equal(process.cwd(), cwdBefore, "stale-session rejection does not change process cwd");
  } finally {
    writer?.close();
    restartedStore?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("managed native association survives owner restart without overwriting another session entry", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-managed-session-association-"));
  const workspacePath = join(root, "worktree");
  const databasePath = join(root, "sessions.sqlite");
  const previousSessionId = "legacy-owner-session" as SessionId;
  const managedSessionId = "managed-owner-session" as SessionId;
  let writer: SqliteSessionStore | undefined;
  let restartedStore: SqliteSessionStore | undefined;
  try {
    await mkdir(workspacePath, { recursive: true });
    writer = new SqliteSessionStore({ dbPath: databasePath });
    for (const sessionId of [previousSessionId, managedSessionId]) {
      await writer.createSession({
        id: sessionId,
        projectID: "project-managed" as ProjectId,
        directory: workspacePath,
        slug: String(sessionId),
        title: String(sessionId),
        version: "test",
        time: { created: 1, updated: 1 },
      });
    }
    await persistWorkspaceAdmissionGeneration(
      { deps: { sessionStore: writer } } as unknown as ZCodeProtocolAgentServerContext,
      { app: { sessionId: previousSessionId } } as unknown as ZCodeProtocolSessionRecord,
      "generation-previous",
    );
    const association = managedWorkspaceSessionAssociationSchema.parse({
      targetId: "target-managed",
      workspaceId: "workspace-managed",
      worktreeGeneration: "generation-managed",
      requestId: "request-managed",
      requestFingerprint: "a".repeat(64),
    });
    await persistWorkspaceAdmissionGeneration(
      { deps: { sessionStore: writer } } as unknown as ZCodeProtocolAgentServerContext,
      { app: { sessionId: managedSessionId } } as unknown as ZCodeProtocolSessionRecord,
      association.worktreeGeneration,
      association,
    );
    writer.close();
    writer = undefined;

    restartedStore = new SqliteSessionStore({ dbPath: databasePath });
    const previousEntries = await restartedStore.sessionEntries({
      sessionID: previousSessionId,
      type: SESSION_ENTRY_WORKSPACE_GENERATION,
    });
    const managedEntries = await restartedStore.sessionEntries({
      sessionID: managedSessionId,
      type: SESSION_ENTRY_WORKSPACE_GENERATION,
    });
    assert.equal(
      (previousEntries[0]?.data as { worktreeGeneration?: string } | undefined)?.worktreeGeneration,
      "generation-previous",
    );
    const managedData = managedEntries.find((entry) => entry.id === `${managedSessionId}:workspace-generation`)
      ?.data as
      | { worktreeGeneration?: string; managedWorkspaceSession?: unknown }
      | undefined;
    assert.equal(managedData?.worktreeGeneration, association.worktreeGeneration);
    assert.deepEqual(
      managedWorkspaceSessionAssociationSchema.parse(managedData?.managedWorkspaceSession),
      association,
    );
    assert.equal(JSON.stringify(managedData).includes("modelKey"), false);
  } finally {
    writer?.close();
    restartedStore?.close();
    await rm(root, { recursive: true, force: true });
  }
});
