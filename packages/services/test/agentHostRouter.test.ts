import assert from "node:assert/strict";
import test from "node:test";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { SessionRouter } from "../src/agent-host/sessionRouter.js";

test("legacy sessions always retain native owner; unknown external sessions fail closed", () => {
  const registry = new HarnessRegistry();
  registry.register(new MockHarness());
  const router = new SessionRouter(registry, { allowExternalAdmission: false });
  assert.deepEqual(router.resolve({ sessionId: "old-session" }, "local-1"), { kind: "native" });
  const meta = {
    schemaVersion: 1 as const,
    harnessId: "mock",
    targetId: "local-1",
    hostSessionId: "new-session",
    modelBindingKind: "host-managed" as const,
  };
  assert.equal(
    router.resolve({ sessionId: "new-session", agentHost: meta }, "local-1").kind,
    "external",
  );
  assert.throws(
    () => router.resolve({ sessionId: "new-session", agentHost: meta }, "remote-2"),
    /target/,
  );
  assert.throws(
    () =>
      router.resolve(
        { sessionId: "new-session", agentHost: { ...meta, harnessId: "unknown" } },
        "local-1",
      ),
    /unknown harness/,
  );
  assert.throws(() => router.assertCanCreate("mock"), /disabled/);
  // The flag changes new-session admission only; an existing external session still routes to its old owner.
  assert.equal(
    router.resolve({ sessionId: "new-session", agentHost: meta }, "local-1").kind,
    "external",
  );
});
