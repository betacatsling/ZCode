import { acquireWorkspaceAdmissionFence } from "@zcode/shared/node";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { CommandInbox } from "../command-inbox.js";

const [root, workspacePath, targetId, generation] = process.argv.slice(2);
if (!root || !workspacePath || !targetId || !generation) {
  throw new Error("workspace-admission process fixture arguments are required");
}

const workspaceId = "workspace-process";
const workspaceIdentity = "process-workspace-identity";

function send(message: unknown): void {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

const inbox = new CommandInbox({
  getRevision: () => 0,
  getLogEpoch: () => "native-session-epoch",
  async acquireWorkspaceAdmission(envelope) {
    send({ type: "admission-entered", operation: envelope.type });
    return acquireWorkspaceAdmissionFence({
      root,
      targetId,
      workspaceId,
      workspaceIdentity,
      workspacePath,
      expectedGeneration: envelope.workspaceAdmissionGeneration,
    });
  },
});

function nativeEnvelope(
  type: "createSession" | "sendText",
  sessionId: string | null,
): CommandEnvelope {
  return {
    commandId: `process-${type}-${sessionId ?? "new"}`,
    clientId: "process-admission-test",
    sessionId,
    ...(sessionId ? { baseRevision: 0, baseLogEpoch: "native-session-epoch" } : {}),
    type,
    payload: type === "createSession" ? { workspaceId } : { text: "new native work" },
    issuedAt: Date.now(),
    workspaceAdmissionGeneration: generation,
  } as CommandEnvelope;
}

async function result(envelope: CommandEnvelope) {
  const outcome = await inbox.handle(envelope);
  if (outcome.kind === "ack") {
    return { status: outcome.ack.status, reasonCode: outcome.ack.reasonCode };
  }
  outcome.settle({ status: "accepted" });
  return { status: "accepted" };
}

function receive(type: "attempts" | "close"): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDisconnect = () => finish(new Error(`parent disconnected before ${type}`));
    const onMessage = (message: unknown) => {
      if ((message as { type?: unknown } | null)?.type === type) finish();
    };
    const finish = (error?: Error) => {
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (error) reject(error);
      else resolve();
    };
    process.on("message", onMessage);
    process.once("disconnect", onDisconnect);
  });
}

async function run(): Promise<void> {
  send({ type: "ready" });
  await receive("attempts");
  const results = await Promise.all([
    result(nativeEnvelope("createSession", null)),
    result(nativeEnvelope("sendText", "native-existing-session")),
  ]);
  send({
    type: "attempts-result",
    results,
    pendingCommandCount: inbox.workspacePins(["native-existing-session"]).pendingCommandCount,
    pendingInputCount: inbox.workspacePins(["native-existing-session"]).pendingInputCount,
  });
  await receive("close");
  send({ type: "closed" });
  process.disconnect();
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: "fatal", message, stack: error instanceof Error ? error.stack : undefined });
  process.exitCode = 1;
  process.disconnect();
});
