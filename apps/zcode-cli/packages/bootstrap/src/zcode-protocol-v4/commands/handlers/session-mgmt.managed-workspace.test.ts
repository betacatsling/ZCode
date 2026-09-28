import assert from "node:assert/strict";
import test from "node:test";
import { managedWorkspaceSessionAssociationSchema } from "@zcode/shared/agent-host";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../executor.js";
import type { V4CommandCoreHost } from "../types.js";

test("explicit managed empty create forwards owner association through native V4 createSession", async () => {
  const association = managedWorkspaceSessionAssociationSchema.parse({
    targetId: "target-native",
    workspaceId: "workspace-native",
    worktreeGeneration: "generation-native",
    requestId: "request-native",
    requestFingerprint: "b".repeat(64),
  });
  let received: unknown;
  const host = {
    async createSessionRecord(params: unknown) {
      received = params;
      return { sessionId: "sess_managed_workspace_test" };
    },
  } as unknown as V4CommandCoreHost;
  const envelope = {
    commandId: "workspace-create:request-native",
    clientId: "agent-host",
    sessionId: null,
    type: "createSession",
    payload: {
      workspaceId: "/tmp/native-worktree",
      config: { modelSelection: { providerId: "provider-native", modelId: "model-native" } },
    },
    issuedAt: Date.now(),
    workspaceAdmissionGeneration: association.worktreeGeneration,
    managedWorkspaceSession: association,
  } as CommandEnvelope;

  const result = await new V4CommandExecutor(host).execute(envelope);

  assert.deepEqual(received, {
    workspaceId: "/tmp/native-worktree",
    workspaceAdmissionGeneration: association.worktreeGeneration,
    managedWorkspaceSession: association,
    config: { modelSelection: { providerId: "provider-native", modelId: "model-native" } },
    mcpServers: undefined,
    offPeakToolEnabled: undefined,
    dynamicWorkflowEnabled: undefined,
  });
  assert.deepEqual(result, {
    type: "createSession",
    sessionId: "sess_managed_workspace_test",
  });
});
