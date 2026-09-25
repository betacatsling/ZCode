import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createSqliteSessionStore } from "./sqlite-session-store.js";
import { ReadonlyNativeSessionMetadataView } from "./native-metadata.js";
import { DatabaseSync } from "node:sqlite";

// 红回归：同一 SQLite 事务必须同时固定原始 session 与不可变 create intent。
test("native create receipt is atomic and rejects reused command intent without a second session", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-create-receipt-"));
  try {
    const store = createSqliteSessionStore({ dbPath: join(dir, "db.sqlite") });
    try {
      const session = {
        id: "original-native" as never,
        projectID: "project" as never,
        workspaceID: "workspace" as never,
        slug: "original-native",
        directory: dir,
        title: "Untitled session",
        version: "test",
      };
      const first = await store.commitNativeCreateReceipt!({
        commandId: "create-1",
        intentFingerprint: "a".repeat(64),
        workspaceScope: "workspace",
        session,
      });
      assert.equal(first.originalSessionId, "original-native");
      const second = await store.commitNativeCreateReceipt!({
        commandId: "create-1",
        intentFingerprint: "a".repeat(64),
        workspaceScope: "workspace",
        session: { ...session, id: "other" as never },
      });
      assert.equal(second.originalSessionId, first.originalSessionId);
      await assert.rejects(
        store.commitNativeCreateReceipt!({
          commandId: "create-1",
          intentFingerprint: "b".repeat(64),
          workspaceScope: "workspace",
          session,
        }),
        /IntentConflict/,
      );
      assert.equal((await store.listSessions()).length, 1);
      const view = new ReadonlyNativeSessionMetadataView(join(dir, "db.sqlite"));
      assert.equal(await view.readCreateReceipt("create-1", "wrong-workspace"), undefined);
      assert.equal(await view.readCreateReceipt("create-1", "workspace"), undefined); // pending is unknown
      await store.completeNativeCreateReceipt!("create-1", session.id);
      const receipt = await view.readCreateReceipt("create-1", "workspace");
      assert.equal(receipt?.originalSessionId, session.id);
      assert.equal(receipt?.status, "completed");
      assert.equal(receipt?.nativeDatabasePath, join(dir, "db.sqlite"));
      const foreignView = new ReadonlyNativeSessionMetadataView(join(dir, "missing.sqlite"));
      assert.equal(await foreignView.readCreateReceipt("create-1", "workspace"), undefined);
      const db = new DatabaseSync(join(dir, "db.sqlite"));
      try {
        assert.equal((db.prepare("select count(*) as n from session").get() as { n: number }).n, 1);
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

for (const stage of ["beforeTransaction", "afterSession", "afterReceipt"] as const) {
  test(`native create rolls back session and receipt on ${stage}`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "native-create-crash-"));
    try {
      const dbPath = join(dir, "db.sqlite");
      const broken = createSqliteSessionStore({ dbPath, nativeCreateFaultAt: stage });
      try {
        await assert.rejects(
          broken.commitNativeCreateReceipt!({
            commandId: "crash",
            workspaceScope: dir,
            intentFingerprint: "c".repeat(64),
            session: {
              id: "uncommitted" as never,
              projectID: "p" as never,
              slug: "uncommitted",
              directory: dir,
              title: "Draft",
              version: "test",
            },
          }),
          /injected native create fault/,
        );
      } finally {
        broken.close();
      }
      const recovered = createSqliteSessionStore({ dbPath });
      try {
        assert.equal((await recovered.listSessions()).length, 0);
        assert.equal(await recovered.getNativeCreateReceipt!("crash"), null);
      } finally {
        recovered.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("after SQLite COMMIT but before ACK retains one original ID and an explicitly pending receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-create-lost-ack-"));
  try {
    const dbPath = join(dir, "native.sqlite");
    const input = {
      commandId: "lost-ack",
      workspaceScope: dir,
      intentFingerprint: "d".repeat(64),
      session: {
        id: "native-original" as never,
        projectID: "p" as never,
        slug: "native-original",
        directory: dir,
        title: "Draft",
        version: "test",
      },
    };
    const interrupted = createSqliteSessionStore({ dbPath, nativeCreateFaultAt: "afterCommit" });
    try {
      await assert.rejects(interrupted.commitNativeCreateReceipt!(input), /afterCommit/);
    } finally {
      interrupted.close();
    }
    const restarted = createSqliteSessionStore({ dbPath });
    try {
      assert.equal((await restarted.getNativeCreateReceipt!(input.commandId))?.status, "pending");
      const returned = await restarted.commitNativeCreateReceipt!({
        ...input,
        session: { ...input.session, id: "must-not-be-created" as never },
      });
      assert.equal(returned.originalSessionId, input.session.id);
      assert.equal((await restarted.listSessions()).length, 1);
      assert.equal(
        await new ReadonlyNativeSessionMetadataView(dbPath).readCreateReceipt(input.commandId, dir),
        undefined,
      );
    } finally {
      restarted.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readonly receipt refuses unsupported schema without upgrading or creating the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-create-unknown-schema-"));
  try {
    const dbPath = join(dir, "unknown.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec("create table session (id text primary key)");
    } finally {
      db.close();
    }
    const view = new ReadonlyNativeSessionMetadataView(dbPath);
    assert.equal(await view.readCreateReceipt("create", dir), undefined);
    const verify = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(
        (
          verify
            .prepare("select count(*) as n from sqlite_master where name = 'schema_migration'")
            .get() as { n: number }
        ).n,
        0,
      );
    } finally {
      verify.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
