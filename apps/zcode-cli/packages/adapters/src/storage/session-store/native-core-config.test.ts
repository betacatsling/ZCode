import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createSqliteSessionStore } from "./sqlite-session-store.js";
import { ReadonlyNativeSessionMetadataView } from "./native-metadata.js";

test("CLI commits actual configuration with receipt; rollback cannot certify a partially persisted draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-core-config-"));
  const dbPath = join(dir, "native.sqlite");
  try {
    const store = createSqliteSessionStore({ dbPath });
    const id = "original-draft" as never;
    const actual = {
      modelSelection: {
        providerId: "fixture",
        modelId: "fixture-model",
        options: { reasoningLevel: "off" },
      },
      mode: "build" as const,
      planEnabled: false,
    };
    const view = new ReadonlyNativeSessionMetadataView(dbPath);
    try {
      await store.commitNativeCreateReceipt!({
        commandId: "create-draft",
        workspaceScope: dir,
        intentFingerprint: "a".repeat(64),
        session: {
          id,
          projectID: "p" as never,
          workspaceID: dir as never,
          slug: "draft",
          directory: dir,
          title: "Untitled session",
          version: "test",
        },
      });
      const fault = new DatabaseSync(dbPath);
      try {
        fault.exec(
          "create trigger fail_completion before update of status on native_create_receipt begin select raise(abort, 'injected-completion-fault'); end",
        );
      } finally {
        fault.close();
      }
      await assert.rejects(
        store.completeNativeCreateReceipt!("create-draft", id, actual),
        /injected-completion-fault/,
      );
      assert.equal(await view.readCertifiedCreateReceipt("create-draft", dir), undefined);
      const inspect = new DatabaseSync(dbPath, { readOnly: true });
      try {
        assert.equal(
          (
            inspect
              .prepare("select count(*) as n from session_entry where session_id = ?")
              .get(id) as { n: number }
          ).n,
          0,
        );
      } finally {
        inspect.close();
      }
      const reset = new DatabaseSync(dbPath);
      try {
        reset.exec("drop trigger fail_completion");
      } finally {
        reset.close();
      }
      await store.completeNativeCreateReceipt!("create-draft", id, actual);
      const certified = await view.readCertifiedCreateReceipt("create-draft", dir);
      assert.equal(certified?.receipt.originalSessionId, id);
      assert.deepEqual(certified?.selection, actual.modelSelection);
      assert.deepEqual(certified?.execution, { mode: "build", planEnabled: false });
      assert.equal(
        await view.readCertifiedCreateReceipt("create-draft", join(dir, "other")),
        undefined,
      );
      await store.saveSessionEntry!({
        id: `${id}:runtime-model-selection`,
        sessionID: id,
        type: "runtime/model_selection",
        touchSession: false,
        time: { created: Date.now(), updated: Date.now() },
        data: { providerId: "other", modelId: "new" },
      });
      assert.deepEqual(
        (await view.readCertifiedCreateReceipt("create-draft", dir))?.selection,
        actual.modelSelection,
        "later mutable model changes cannot rewrite immutable create-time proof",
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
