import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createSqliteSessionStore,
  ReadonlyNativeSessionMetadataView,
} from "@zcode/adapters/storage";
import { lookupGlobalCreateSessionCommand } from "./create-session-command-fact.js";
import { nativeCreateIntent } from "./native-create-intent.js";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";

const command = (workspaceId: string, extra: object = {}, clientId = "desktop", issuedAt = 1) =>
  ({
    type: "createSession",
    commandId: "create-1",
    sessionId: null,
    clientId,
    issuedAt,
    payload: { workspaceId, ...extra },
  }) as CommandEnvelope;

test("canonical create fingerprint excludes transport but includes workspace/model/config/firstInput", () => {
  const original = command("workspace", { config: { model: "model-a" } });
  assert.deepEqual(
    nativeCreateIntent(original),
    nativeCreateIntent(command("workspace", { config: { model: "model-a" } }, "mobile", 2)),
  );
  for (const changed of [
    command("other", { config: { model: "model-a" } }),
    command("workspace", { config: { model: "model-b" } }),
    command("workspace", { config: { model: "model-a" }, firstInput: { text: "hello" } }),
  ]) {
    assert.notEqual(
      nativeCreateIntent(original).intentFingerprint,
      nativeCreateIntent(changed).intentFingerprint,
    );
  }
});

test("query never discards live admitted firstInput; restarted pending is not promoted", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-create-input-"));
  try {
    const dbPath = join(root, "native.sqlite");
    const store = createSqliteSessionStore({ dbPath });
    const cmd = command(root, { firstInput: { text: "fixture input" } });
    const sessionId = "native-original" as never;
    try {
      await store.commitNativeCreateReceipt!({
        commandId: cmd.commandId,
        ...nativeCreateIntent(cmd),
        hasFirstInput: true,
        session: {
          id: sessionId,
          projectID: "p" as never,
          slug: "native-original",
          directory: root,
          title: "Draft",
          version: "test",
        },
      });
      assert.equal(
        (await lookupGlobalCreateSessionCommand(store, cmd.commandId))?.reasonCode,
        "fault.command.createPending",
      );
      await store.saveSessionInput!({
        id: `queue_${cmd.commandId}`,
        sessionID: sessionId,
        kind: "sendText",
        delivery: "startNow",
        payload: {
          text: "fixture input",
          sourceCommandType: "createSession",
          conversationInputIntent: { sourceCommandId: cmd.commandId },
        },
      });
      await store.completeNativeCreateReceipt!(cmd.commandId, sessionId);
      const live = await lookupGlobalCreateSessionCommand(store, cmd.commandId, () => true);
      assert.equal(live?.status, "accepted");
      assert.equal(live?.result?.type, "createSession");
      const restarted = await lookupGlobalCreateSessionCommand(store, cmd.commandId);
      assert.equal(restarted?.reasonCode, "fault.command.inputPending");
      assert.equal(
        (await store.getSessionInputById!(`queue_${cmd.commandId}`))?.status,
        "admitted",
      );
      assert.equal(
        await new ReadonlyNativeSessionMetadataView(dbPath).readCreateReceipt(cmd.commandId, root),
        undefined,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CommandInbox rejects in-flight intent reuse and allows completed readonly retry while frozen", async () => {
  const { CommandInbox } = await import("./command-inbox.js");
  const root = await mkdtemp(join(tmpdir(), "native-inbox-freeze-"));
  try {
    const store = createSqliteSessionStore({ dbPath: join(root, "native.sqlite") });
    try {
      const inbox = new CommandInbox({
        getRevision: () => 0,
        getLogEpoch: () => null,
        validateCreateRetry: async (envelope) => {
          const receipt = await store.getNativeCreateReceipt!(envelope.commandId);
          const intent = nativeCreateIntent(envelope);
          return (
            !receipt ||
            (receipt.workspaceScope === intent.workspaceScope &&
              receipt.intentFingerprint === intent.intentFingerprint)
          );
        },
        lookupTranscriptCommand: (key) => lookupGlobalCreateSessionCommand(store, key.commandId),
      });
      const original = command(root);
      const executing = await inbox.handle(original);
      assert.equal(executing.kind, "execute");
      const different = await inbox.handle(command(join(root, "other")));
      assert.equal(different.kind, "ack");
      if (different.kind === "ack")
        assert.equal(different.ack.reasonCode, "guard.nativeCreateIntentConflict");
      assert.equal((await store.listSessions()).length, 0);
      const originalId = "original-inbox" as never;
      await store.commitNativeCreateReceipt!({
        commandId: original.commandId,
        ...nativeCreateIntent(original),
        session: {
          id: originalId,
          projectID: "p" as never,
          slug: "original-inbox",
          directory: root,
          title: "Draft",
          version: "test",
        },
      });
      await store.completeNativeCreateReceipt!(original.commandId, originalId);
      if (executing.kind === "execute")
        executing.settle({
          status: "accepted",
          result: { type: "createSession", sessionId: originalId },
        });
      const lease = inbox.freeze();
      assert.equal(
        (await inbox.query([{ commandId: original.commandId, sessionId: null }]))[0]?.result !==
          "unknown",
        true,
      );
      const duplicate = await inbox.handle(command(root, {}, "mobile", 5));
      assert.equal(duplicate.kind, "ack");
      if (duplicate.kind === "ack") assert.equal(duplicate.ack.status, "duplicate");
      assert.equal(inbox.release(lease), true);
      assert.equal((await store.listSessions()).length, 1);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
