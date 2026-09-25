import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeCreateJournal } from "./nativeCreateJournal.js";

const intent = (root: string) => ({
  schemaVersion: 1 as const,
  commandId: "stable-command",
  targetId: "target",
  projectId: "project",
  workspaceId: "catalog-workspace",
  repositoryBindingId: "binding",
  worktreeGeneration: "generation-1",
  workspaceIdentity: "remote:identity",
  workspacePath: join(root, "worktree"),
  remoteSessionId: "attachment-1",
  cwdRelativeToWorktree: ".",
  modelBinding: {
    kind: "host-managed" as const,
    selection: {
      providerId: "fixture",
      modelId: "fixture-model",
      options: { reasoningLevel: "off" },
    },
  },
  nativeDatabasePath: join(root, "native.sqlite"),
  databaseId: createHash("sha256").update(join(root, "native.sqlite")).digest("hex"),
  // The exact parsed V4 payload fingerprint is supplied by the actual CLI command builder.
  intentFingerprint: "b".repeat(64),
});

test("new native intent is durable, distinct from legacy backup, and conflicting retry cannot overwrite it", async () => {
  const root = await mkdtemp(join(tmpdir(), "core-native-journal-"));
  try {
    const journal = new NativeCreateJournal(join(root, "native-create"));
    const first = intent(root);
    await journal.stage(first);
    assert.deepEqual(
      await new NativeCreateJournal(join(root, "native-create")).read(first.commandId),
      {
        intent: first,
        mapping: undefined,
      },
    );
    await journal.stage(first);
    await assert.rejects(
      journal.stage({ ...first, worktreeGeneration: "generation-2" }),
      /conflict/,
    );
    assert.deepEqual((await journal.read(first.commandId))?.intent, first);
    await assert.rejects(readFile(join(root, "native-migration", "mapping.json")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing/unsupported native SQLite never upgrades pending intent to a writable mapping", async () => {
  const root = await mkdtemp(join(tmpdir(), "core-native-journal-"));
  try {
    const journal = new NativeCreateJournal(join(root, "native-create"));
    const first = intent(root);
    await journal.stage(first);
    await assert.rejects(journal.complete(first.commandId), /uncertain|unavailable/);
    assert.equal((await journal.read(first.commandId))?.mapping, undefined);
    await writeFile(first.nativeDatabasePath, "not a supported SQLite schema");
    await assert.rejects(journal.complete(first.commandId), /uncertain/);
    assert.equal((await journal.read(first.commandId))?.mapping, undefined);
    await assert.rejects(
      journal.stage({ ...first, commandId: "wrong-db", databaseId: "0".repeat(64) }),
      /storage-identity/,
    );
    await assert.rejects(
      journal.stage({ ...first, commandId: "relative-db", nativeDatabasePath: "native.sqlite" }),
      /path-not-absolute/,
    );
    assert.equal((await journal.read(first.commandId))?.intent.commandId, first.commandId);
    // 中文：同物理路径不同远端 identity 永远不是原 workspace 的复用命令。
    const remote = { ...first, commandId: "another-remote", workspaceIdentity: "remote:other" };
    await journal.stage(remote);
    assert.equal((await journal.read(remote.commandId))?.mapping, undefined);
    assert.notDeepEqual(
      (await journal.read(first.commandId))?.intent,
      (await journal.read(remote.commandId))?.intent,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
