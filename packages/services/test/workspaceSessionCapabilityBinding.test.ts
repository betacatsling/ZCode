import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceSessionCapabilityReader } from "../src/agent-host/workspaceSessionCapability.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { catalog, NoCostPi, targetId } from "./fixtures/workspaceSessionCreation.js";

const availableTarget = {
  id: targetId,
  kind: "local" as const,
  platform: process.platform as "darwin" | "linux" | "win32",
  available: true,
};

test("workspaceSessionCapability soft-pins model-binding-mismatch and harness-unavailable", async () => {
  const registry = new HarnessRegistry();
  registry.register(new NoCostPi());

  const withNative = createWorkspaceSessionCapabilityReader({
    target: availableTarget,
    catalog,
    registry,
    hasNativeOwner: true,
  });
  const withoutNative = createWorkspaceSessionCapabilityReader({
    target: availableTarget,
    catalog,
    registry,
    hasNativeOwner: false,
  });

  const hostManaged = {
    kind: "host-managed" as const,
    selection: { providerId: "provider-pi", modelId: "model-pi" },
  };
  const nativeSelection = {
    kind: "native-selection" as const,
    selection: { providerId: "provider-native", modelId: "model-native" },
  };

  const nativeMismatch = await withNative({
    harnessId: "zcode",
    modelBinding: hostManaged,
  });
  assert.equal(nativeMismatch.report.support, "unsupported");
  assert.equal(nativeMismatch.report.reason, "model-binding-mismatch");

  const externalMismatch = await withNative({
    harnessId: "pi",
    modelBinding: nativeSelection,
  });
  assert.equal(externalMismatch.report.support, "unsupported");
  assert.equal(externalMismatch.report.reason, "model-binding-mismatch");

  const nativeOwnerMissing = await withoutNative({
    harnessId: "zcode",
    modelBinding: nativeSelection,
  });
  assert.equal(nativeOwnerMissing.report.support, "unsupported");
  assert.equal(nativeOwnerMissing.report.reason, "harness-unavailable");

  const unknownHarness = await withNative({
    harnessId: "missing-harness",
    modelBinding: hostManaged,
  });
  assert.equal(unknownHarness.report.support, "unsupported");
  assert.equal(unknownHarness.report.reason, "harness-unavailable");
});
