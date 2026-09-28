import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  acquireWorkspaceAdmissionFence,
  atomicWritePrivateTextFile,
  workspaceAdmissionFenceFilePath,
} from "@zcode/shared/node";
import {
  conversationInputIntentSchema,
  type CommandEnvelope,
} from "@zcode/shared/zcode-protocol-v4";
import { CommandInbox } from "./command-inbox.js";

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-native-admission-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sendEnvelope(type: "sendText" | "resolveInteraction", payload: unknown): CommandEnvelope {
  return {
    commandId: randomUUID(),
    clientId: "test-client",
    sessionId: "session-1",
    baseRevision: 0,
    baseLogEpoch: "session-epoch",
    type,
    payload,
    issuedAt: Date.now(),
    workspaceAdmissionGeneration: "generation-1",
  } as CommandEnvelope;
}

async function writeFence(root: string, lifecycle: "active" | "archived" | "frozen" | "removed") {
  const targetId = "target-local";
  const workspacePath = "/tmp/native workspace\nwith newline";
  const workspaceIdentity = "native-identity";
  const fencePath = workspaceAdmissionFenceFilePath(
    root,
    targetId,
    workspaceIdentity,
    workspacePath,
  );
  await atomicWritePrivateTextFile(
    fencePath,
    `${JSON.stringify({
      schemaVersion: 1,
      targetId,
      workspaceId: "workspace-1",
      workspaceKey: workspaceIdentity,
      worktreePath: workspacePath,
      worktreeGeneration: "generation-1",
      lifecycle,
      ...(lifecycle === "frozen"
        ? { freezeToken: "remove-token", previousLifecycle: "active" }
        : {}),
    })}\n`,
  );
  return { root, targetId, workspacePath, workspaceIdentity };
}

function createInbox(request: {
  root: string;
  targetId: string;
  workspacePath: string;
  workspaceIdentity: string;
}) {
  let gateAcquireCount = 0;
  const inbox = new CommandInbox({
    getRevision: () => 0,
    getLogEpoch: () => "session-epoch",
    async acquireWorkspaceAdmission(envelope) {
      gateAcquireCount += 1;
      return acquireWorkspaceAdmissionFence({
        ...request,
        expectedGeneration: envelope.workspaceAdmissionGeneration,
      });
    },
  });
  return { inbox, gateAcquireCount: () => gateAcquireCount };
}

test("frozen native fence rejects new send while approval decline stays available", async () => {
  await withRoot(async (root) => {
    const request = await writeFence(root, "frozen");
    const { inbox, gateAcquireCount } = createInbox(request);
    const send = await inbox.handle(sendEnvelope("sendText", { text: "new work" }));
    assert.equal(send.kind, "ack");
    if (send.kind === "ack") {
      assert.equal(send.ack.status, "rejected");
      assert.equal(send.ack.reasonCode, "guard.workspaceAdmissionUnavailable");
    }
    assert.equal(inbox.workspacePins(["session-1"]).pendingCommandCount, 0);

    const declined = await inbox.handle(
      sendEnvelope("resolveInteraction", {
        interactionId: "approval-1",
        answer: { action: "decline" },
      }),
    );
    assert.equal(declined.kind, "execute");
    assert.equal(gateAcquireCount(), 1);
    if (declined.kind === "execute") declined.settle({ status: "accepted" });
  });
});

test("CommandInbox pin reports accepted held input as pending and rejects approval acceptance during freeze", async () => {
  await withRoot(async (root) => {
    const request = await writeFence(root, "active");
    const { inbox, gateAcquireCount } = createInbox(request);
    const envelope = sendEnvelope("sendText", { text: "held work" });
    const outcome = await inbox.handle(envelope);
    assert.equal(outcome.kind, "execute");
    if (outcome.kind !== "execute") return;
    const intent = conversationInputIntentSchema.parse({
      sourceCommandId: envelope.commandId,
      queueItemId: outcome.queueItemId,
      clientId: envelope.clientId,
      kind: "sendText",
      text: "held work",
      delivery: { requested: "queue", admitted: "queue" },
      order: { admissionSeq: outcome.admissionSeq, queuePosition: 0 },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
      admittedAt: outcome.admittedAt,
    });
    inbox.pinLiveInput("session-1", intent, outcome.ack);
    outcome.settle({ status: "accepted" });
    assert.deepEqual(inbox.workspacePins(["session-1"]), {
      pendingCommandCount: 0,
      pendingInputCount: 1,
    });

    await writeFence(root, "frozen");
    const accepted = await inbox.handle(
      sendEnvelope("resolveInteraction", {
        interactionId: "approval-2",
        answer: { action: "accept" },
      }),
    );
    assert.equal(accepted.kind, "ack");
    if (accepted.kind === "ack") assert.equal(accepted.ack.status, "rejected");
    assert.equal(gateAcquireCount(), 2);
  });
});
