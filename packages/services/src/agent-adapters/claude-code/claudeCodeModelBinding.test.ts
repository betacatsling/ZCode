import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionTarget, ModelBindingRequest, SessionSpec } from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { ClaudeCodeAdapterError } from "./claudeCodeErrors.js";
import { AcpMarkingTransport, FakeClaudeCodeTransport } from "./claudeCodeFakeTransport.js";
import { ClaudeCodeHarnessAdapter } from "./claudeCodeHarnessAdapter.js";
import {
  reportClaudeCodeModelChain,
  type ClaudeCodeModelBindingInspection,
  type ClaudeCodeModelBindingPort,
} from "./claudeCodeModelReport.js";
import type { ClaudeCodeProfileSink } from "./claudeCodeProfile.js";
import { CLAUDE_CODE_ADAPTER_VERSION } from "./claudeCodeVersion.js";

const SECRET = "TEST_ONLY_SECRET_VALUE";
const selection: ModelSelection = {
  providerId: "provider-a",
  modelId: "model-a",
  options: { reasoningLevel: "low" },
};

class MemoryProfileSink implements ClaudeCodeProfileSink {
  writes = 0;
  async writeMarker(): Promise<void> {
    this.writes += 1;
  }
  async removeProfile(): Promise<void> {}
}

function requested(): ModelBindingRequest {
  return { kind: "host-managed", selection };
}

function inspection(
  patch: Partial<ClaudeCodeModelBindingInspection> = {},
): ClaudeCodeModelBindingInspection {
  return {
    evidence: { kind: "port-mock" },
    reachedModelExecutionLayer: false,
    reason: "mock",
    ...patch,
  };
}

test("model chain stays experimental unless the execution layer is witnessed", () => {
  const mock = reportClaudeCodeModelChain({
    requested: requested(),
    inspection: inspection({ reachedModelExecutionLayer: true, reason: `leak ${SECRET}` }),
    acpSessionOpen: false,
    secrets: [SECRET],
  });
  assert.equal(mock.support.support, "experimental");
  assert.equal(mock.route, "harness-managed");
  assert.equal(mock.label, "experimental");
  assert.equal(mock.reachedModelExecutionLayer, false);
  assert.equal(mock.acpProvesHostModel, false);
  assert.equal(JSON.stringify(mock).includes(SECRET), false);

  const acp = reportClaudeCodeModelChain({
    requested: requested(),
    inspection: inspection({ evidence: { kind: "acp-session" } }),
    acpSessionOpen: true,
  });
  assert.equal(acp.support.support, "experimental");
  assert.match(acp.support.reason ?? "", /ACP session does not prove/);
  assert.equal(acp.support.constraints?.acpProvesHostModel, false);

  const mismatch = reportClaudeCodeModelChain({
    requested: requested(),
    inspection: inspection({
      evidence: { kind: "model-execution-layer", executionRef: "exec-1" },
      reachedModelExecutionLayer: true,
      effectiveProviderId: "provider-a",
      effectiveModelId: "other-model",
    }),
    acpSessionOpen: false,
  });
  assert.equal(mismatch.support.support, "unsupported");
  assert.match(mismatch.support.reason ?? "", /refusing to downgrade/);
  assert.equal(mismatch.support.constraints?.requestedModelId, "model-a");

  const witnessed = reportClaudeCodeModelChain({
    requested: requested(),
    inspection: inspection({
      evidence: { kind: "model-execution-layer", executionRef: "exec-1" },
      reachedModelExecutionLayer: true,
      effectiveProviderId: "provider-a",
      effectiveModelId: "model-a",
    }),
    acpSessionOpen: true,
  });
  assert.equal(witnessed.support.support, "supported");
  assert.equal(witnessed.route, "messages-gateway");
  assert.equal(witnessed.reachedModelExecutionLayer, true);
  assert.equal(witnessed.acpProvesHostModel, false);
  assert.equal(witnessed.support.constraints?.acpProvesHostModel, false);
});

test("adapter reports control plane and host-managed chain separately", async () => {
  const sink = new MemoryProfileSink();
  let inspections = 0;
  const port: ClaudeCodeModelBindingPort = {
    async inspect(query) {
      inspections += 1;
      assert.equal(query.requested.kind, "host-managed");
      return inspection({
        reason: "Mock port did not call the model execution layer",
        ...(query.acpSessionOpen ? { evidence: { kind: "acp-session" as const } } : {}),
      });
    },
  };
  const adapter = new ClaudeCodeHarnessAdapter({
    managedRoot: "/managed/claude-code",
    userHome: "/home/user",
    transport: new FakeClaudeCodeTransport({ userHome: "/home/user" }),
    profileSink: sink,
    modelBindingPort: port,
    now: () => 10,
  });
  const local: ExecutionTarget = {
    id: "target-local",
    kind: "local",
    platform: process.platform as ExecutionTarget["platform"],
    available: true,
  };
  const separated = await adapter.separatedReport(local, selection);
  assert.equal(separated.controlPlane.support, "supported");
  assert.equal(separated.controlPlane.constraints?.plane, "control");
  assert.equal(separated.hostManagedModelChain.support.support, "experimental");
  assert.equal(separated.hostManagedModelChain.route, "harness-managed");
  assert.equal(separated.hostManagedModelChain.reachedModelExecutionLayer, false);
  assert.notEqual(separated.controlPlane, separated.hostManagedModelChain.support);

  const capabilities = await adapter.capabilities(local);
  assert.equal(capabilities.hostManagedModel?.support, "experimental");
  assert.equal(capabilities.text.support, "supported");

  const spec: SessionSpec = {
    schemaVersion: 1,
    hostSessionId: "host-managed-session",
    execution: {
      targetId: "target-local",
      workspaceIdentity: "workspace-identity-a",
      worktreePath: "/tmp/worktree-a",
    },
    harness: { id: "claude-code", adapterVersion: CLAUDE_CODE_ADAPTER_VERSION },
    modelBinding: requested(),
  };
  const writesBefore = sink.writes;
  await assert.rejects(
    adapter.create(spec, {} as never),
    (error: unknown) => error instanceof ClaudeCodeAdapterError && error.code === "unsupported",
  );
  assert.equal(sink.writes, writesBefore);

  const inspectionsBeforeOffline = inspections;
  const unavailable = await adapter.hostManagedSupport(
    { ...local, available: false, reason: "offline" },
    selection,
  );
  assert.equal(unavailable.support, "unsupported");
  assert.equal(inspections, inspectionsBeforeOffline);

  const acp = new ClaudeCodeHarnessAdapter({
    managedRoot: "/managed/claude-code",
    userHome: "/home/user",
    transport: new AcpMarkingTransport(new FakeClaudeCodeTransport({ userHome: "/home/user" })),
    profileSink: new MemoryProfileSink(),
    modelBindingPort: port,
    now: () => 10,
  });
  const acpReport = await acp.hostManagedSupport(local, selection);
  assert.equal(acpReport.support, "experimental");
  assert.match(acpReport.reason ?? "", /ACP session does not prove/);
  assert.equal(acpReport.constraints?.acpProvesHostModel, false);
  await assert.rejects(acp.create(spec, {} as never), (error: unknown) => {
    return error instanceof ClaudeCodeAdapterError && error.code === "unsupported";
  });
  await acp.shutdown();
  await adapter.shutdown();
});
