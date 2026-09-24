import assert from "node:assert/strict";
import test from "node:test";
import { sessionSummarySchema } from "@zcode/shared/zcode-protocol-v4";
import { resolveSessionHarness } from "@zcode/shared/agent-host";

const nativeSummary = {
  sessionId: "legacy-session", workspaceId: "workspace-1", title: "Native history",
  phase: "completedSuccess", sessionEnded: true, hasBackgroundWork: false,
  lastActivityAt: 1, createdAt: 1,
};

test("legacy V4 index remains native, external identity is additive and does not widen glm", () => {
  assert.equal(resolveSessionHarness(sessionSummarySchema.parse(nativeSummary).agentHost), "zcode");
  const external = sessionSummarySchema.parse({
    ...nativeSummary,
    agentHost: { schemaVersion: 1, harnessId: "pi", targetId: "ssh-a", hostSessionId: "external-1", modelBindingKind: "host-managed" },
  });
  assert.equal(resolveSessionHarness(external.agentHost), "pi");
  assert.equal(sessionSummarySchema.safeParse({ ...nativeSummary, agentHost: { schemaVersion: 2, harnessId: "unknown" } }).success, false);
});
