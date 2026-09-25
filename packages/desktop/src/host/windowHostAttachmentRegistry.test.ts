import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { createWindowHostAttachmentRegistry } from "./windowHostAttachmentRegistry.js";

test("Core loss detaches local renderer ports without dropping remote window attachment", () => {
  const disposed: string[] = [];
  const registry = createWindowHostAttachmentRegistry({
    resolveScope: () => ({ services: {}, generation: 1 }),
    expose: ({ attachmentId }) => ({
      dispose: () => {
        disposed.push(attachmentId);
      },
    }),
  });
  const local = new EventEmitter();
  const remote = new EventEmitter();
  const phone = new EventEmitter();
  registry.attach({
    requestId: "phone-request",
    attachmentId: "phone",
    clientMode: "web-remote-replayable",
    scope: {
      kind: "phone",
      workspaceId: "work",
      hostSessionId: "session",
      workspacePath: "/local",
      workspaceIdentity: "/local",
    },
    port: phone,
  });
  registry.attach({
    requestId: "local-request",
    attachmentId: "local",
    clientMode: "desktop-continuous",
    scope: { kind: "local" },
    port: local,
  });
  registry.attach({
    requestId: "remote-request",
    attachmentId: "remote",
    clientMode: "desktop-continuous",
    scope: {
      kind: "remote",
      remoteSessionId: "session",
      workspacePath: "/remote",
      workspaceIdentity: "remote:identity",
    },
    port: remote,
  });
  registry.detachLocalAttachments();
  assert.deepEqual(disposed, ["phone", "local"]);
  assert.deepEqual(
    registry.list().map((item) => item.attachmentId),
    ["remote"],
  );
  local.emit("close");
  assert.equal(registry.size(), 1);
  registry.dispose();
  assert.deepEqual(disposed, ["phone", "local", "remote"]);
});
