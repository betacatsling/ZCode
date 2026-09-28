import { AgentHostTargetService, HarnessRegistry, MockHarness } from "@zcode/services/node";
import { withWorkspaceAdmissionFence } from "@zcode/shared/node";

const fixtureArgs = process.argv.slice(2);
const fenceRootArgument = fixtureArgs[0];
const workspacePathArgument = fixtureArgs[1];
const targetIdArgument = fixtureArgs[2];
const generationArgument = fixtureArgs[3];
if (!fenceRootArgument || !workspacePathArgument || !targetIdArgument || !generationArgument) {
  throw new Error("external workspace admission fixture arguments are required");
}
const fenceRoot = fenceRootArgument;
const workspacePath = workspacePathArgument;
const targetId = targetIdArgument;
const generation = generationArgument;

const workspaceId = "workspace-process";
const workspaceIdentity = "external-process-workspace";
const workspace = {
  id: workspaceId,
  workspaceIdentity,
  worktreePath: workspacePath,
  worktreeGeneration: generation,
  lifecycle: "active",
  verification: "verified",
};

function send(message: unknown): void {
  if (typeof process.send === "function" && process.connected) process.send(message);
}

function disconnect(): void {
  if (typeof process.disconnect === "function" && process.connected) process.disconnect();
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

const registry = new HarnessRegistry();
registry.register(new MockHarness());
const service = new AgentHostTargetService({
  root: `${fenceRoot}/external-sessions`,
  target: {
    id: targetId,
    kind: "local",
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  },
  catalog: { fingerprint: "cross-process-admission", validateSelection: () => ({ ok: true }) },
  registry,
  authorizeWorktree: async () => true,
  worktrees: {
    async read() {
      return { workspaces: [workspace] };
    },
  } as never,
  async withWorkspaceAdmission(spec, operation) {
    send({ type: "admission-entered", operation: spec.hostSessionId });
    return withWorkspaceAdmissionFence(
      {
        root: fenceRoot,
        targetId,
        workspaceId: spec.execution.workspaceId,
        workspaceIdentity: spec.execution.workspaceIdentity,
        workspacePath: spec.execution.worktreePath,
        expectedGeneration: spec.execution.worktreeGeneration,
      },
      operation,
    );
  },
});

const harness = { id: "mock", adapterVersion: "1.0.0" };
const modelBinding = {
  kind: "host-managed" as const,
  selection: { providerId: "fixture-provider", modelId: "fixture-model" },
};
const existingSessionId = "external-existing-session";
const existingSpec = {
  schemaVersion: 1 as const,
  hostSessionId: existingSessionId,
  execution: {
    targetId,
    workspaceIdentity,
    worktreePath: workspacePath,
    workspaceId,
    worktreeGeneration: generation,
  },
  harness,
  modelBinding,
};

async function run(): Promise<void> {
  await service.createExternalForWorkspace({
    workspaceId,
    worktreeGeneration: generation,
    hostSessionId: existingSessionId,
    harness,
    modelBinding,
  });
  send({ type: "ready" });
  await receive("attempts");

  const results = await Promise.all([
    service
      .createExternalForWorkspace({
        workspaceId,
        worktreeGeneration: generation,
        hostSessionId: "external-new-session",
        harness,
        modelBinding,
      })
      .then(() => ({ status: "accepted" }))
      .catch((error: unknown) => ({ status: "rejected", message: String(error) })),
    service
      .dispatch(existingSpec, {
        type: "send",
        commandId: "external-process-send",
        hostSessionId: existingSessionId,
        turnId: "external-process-turn",
        text: "new work must be denied",
      })
      .then((result) => ({ status: result.status }))
      .catch((error: unknown) => ({ status: "rejected", message: String(error) })),
  ]);
  const history = await service.snapshot(existingSpec);
  const index = await service.listActivityIndex();
  send({
    type: "attempts-result",
    results,
    historySequence: history.seq,
    sessionCount: index.sessions.length,
    activityState: index.sessions[0]?.state,
  });
  await receive("close");
  await service.close();
  send({ type: "closed" });
  disconnect();
}

void run().catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  send({ type: "fatal", message, stack: error instanceof Error ? error.stack : undefined });
  await service.close().catch(() => undefined);
  process.exitCode = 1;
  disconnect();
});
