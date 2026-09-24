import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ReadonlyNativeSessionMetadataView, SqliteSessionStore } from "@zcode/adapters/storage";
import { SESSION_ENTRY_MODEL_SELECTION, type SessionId, type ProjectId } from "@zcode/contracts";
import { buildRemoteWorkspaceIdentity } from "@zcode/shared";
import {
  NativeSessionDirectory,
  nativeTreeSessionId,
} from "../src/session/nativeSessionDirectory.js";
import { JoinedSessionIndex, nativeZcodeManifest } from "../src/session/nativeComposition.js";
import { NativeSqliteMetadataReader } from "../src/session/nativePersistentSessionIndex.js";

const sid = "closed-session" as SessionId;
test("readonly CLI session metadata sees WAL changes without openStartup or Agent, rejects unknown schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-view-"));
  const configuredRelative = "custom/native.sqlite";
  const dbPath = join(root, configuredRelative); // Native bootstrap getSessionDbPath(config, cwd) resolves this.
  const owner = await SqliteSessionStore.openStartup({ dbPath });
  try {
    await owner.createSession({
      id: sid,
      projectID: "p" as ProjectId,
      slug: "s",
      directory: "/repo/src",
      title: "closed",
      version: "1",
    });
    const view = new ReadonlyNativeSessionMetadataView(dbPath);
    const reader = new NativeSqliteMetadataReader(view, async () => "target");
    assert.equal(
      (await reader.read({ workspaceKey: "/repo", workspacePath: "/repo", nativeSessionId: sid }))
        ?.cwd,
      "/repo/src",
    );
    assert.equal(
      await reader.read({ workspaceKey: "/other", workspacePath: "/other", nativeSessionId: sid }),
      undefined,
    );
    assert.equal(await view.read("missing"), undefined);
    await owner.saveSessionEntry({
      id: "model",
      sessionID: sid,
      type: SESSION_ENTRY_MODEL_SELECTION,
      time: { created: 1, updated: 2 },
      data: { providerId: "p", modelId: "m" },
    });
    assert.deepEqual(
      (await reader.read({ workspaceKey: "/repo", workspacePath: "/repo", nativeSessionId: sid }))
        ?.modelBinding,
      { kind: "host-managed", selection: { providerId: "p", modelId: "m" } },
    );
    await owner.saveSessionEntry({
      id: "bad",
      sessionID: sid,
      type: SESSION_ENTRY_MODEL_SELECTION,
      time: { created: 3, updated: 4 },
      data: { providerId: "p", modelId: "" },
    });
    assert.equal(
      (await reader.read({ workspaceKey: "/repo", workspacePath: "/repo", nativeSessionId: sid }))
        ?.suppressIndexModelFallback,
      true,
    );
    const mutation = new DatabaseSync(dbPath);
    try {
      mutation.exec(
        "INSERT INTO schema_migration (id, checksum, time_applied) VALUES ('9999_future', 'x', 0)",
      );
    } finally {
      mutation.close();
    }
    await assert.rejects(() => view.read(sid), /unknown-native-session-schema/);
  } finally {
    owner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("readonly view never creates missing DB, and rejects malformed schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-missing-"));
  try {
    await assert.rejects(() =>
      new ReadonlyNativeSessionMetadataView(join(root, "absent.sqlite")).read(sid),
    );
    const db = new DatabaseSync(join(root, "malformed.sqlite"));
    db.exec("CREATE TABLE schema_migration (id TEXT, checksum TEXT)");
    db.close();
    await assert.rejects(
      () => new ReadonlyNativeSessionMetadataView(join(root, "malformed.sqlite")).read(sid),
      /unknown-native-session-schema/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bounded tree IDs isolate targets, nested scopes and long remote identities; joining preserves unknown", async () => {
  const longRemote = buildRemoteWorkspaceIdentity(`/${"long/".repeat(350)}`, {
    kind: "ssh",
    host: "host.invalid",
    username: "test",
  });
  const a = nativeTreeSessionId({
    targetId: "local",
    sourceWorkspaceKey: "/repo",
    nativeSessionId: "same",
  });
  const nested = nativeTreeSessionId({
    targetId: "local",
    sourceWorkspaceKey: "/repo/src",
    nativeSessionId: "same",
  });
  const remote = nativeTreeSessionId({
    targetId: "remote",
    sourceWorkspaceKey: longRemote,
    nativeSessionId: "same",
  });
  assert.equal(new Set([a, nested, remote]).size, 3);
  assert.ok(remote.length <= 256);
  assert.equal(nativeZcodeManifest.icon?.light, "builtin:zcode");
  const directory = new NativeSessionDirectory({
    async listMappings() {
      return [
        {
          legacyId: JSON.stringify([longRemote, "same"]),
          nativeSessionId: "same",
          sourceWorkspaceKey: longRemote,
          sourceWorkspacePath: "/repo/src",
          projectId: "p",
          workspaceId: "w",
          targetId: "remote",
          worktreeGeneration: "generation",
          cwdRelativeToWorktree: "src",
          modelBinding: {
            kind: "host-managed" as const,
            selection: { providerId: "p", modelId: "m" },
          },
        },
      ];
    },
    async readFacts() {
      return [
        {
          workspaceKey: longRemote,
          nativeSessionId: "same",
          title: "closed",
          updatedAt: 1,
          status: "completed",
          archived: false,
          deleted: false,
          unread: false,
          nativeModel: "p/m",
        },
      ];
    },
  });
  assert.equal((await directory.allSessions())[0]?.session.id, remote);
  const navigation = await directory.resolveOwner({
    targetId: "remote",
    workspaceId: "w",
    sourceWorkspaceKey: longRemote,
    nativeSessionId: "same",
  });
  assert.equal(navigation?.treeSessionId, remote);
  assert.equal(navigation?.owner.sourceWorkspaceKey, longRemote);
  assert.equal(navigation?.owner.nativeSessionId, "same");
  assert.equal(navigation?.owner.cwdRelativeToWorktree, "src");
  assert.deepEqual(await directory.resolveOwner({ treeSessionId: remote }), navigation);
  assert.equal(await directory.resolveOwner({ treeSessionId: a }), undefined);
  const rows = [
    {
      session: {
        schemaVersion: 1 as const,
        id: a,
        projectId: "p",
        workspaceId: "w",
        harnessId: "zcode",
        title: "closed",
        sortOrder: 0,
        archived: false,
      },
      updatedAt: 1,
      activity: "unknown" as const,
      freshness: "unknown" as const,
      unread: false,
    },
  ];
  const native = {
    async allSessions() {
      return rows;
    },
    async workspaceFreshness() {
      return "unknown" as const;
    },
  };
  const external = {
    async allSessions() {
      return [];
    },
    async workspaceFreshness() {
      return "offline" as const;
    },
  };
  const joined = new JoinedSessionIndex(native, external);
  assert.deepEqual(await joined.allSessions(), rows);
  assert.equal(await joined.workspaceFreshness({ id: "w" } as never), "offline");
  await assert.rejects(
    () => new JoinedSessionIndex(native, native).allSessions(),
    /duplicate-session-tree-id/,
  );
});
