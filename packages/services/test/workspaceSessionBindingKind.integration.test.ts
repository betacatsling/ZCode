import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import {
  createAgentHostTarget,
  createLinkedWorktreeFixture,
  createSqliteNativeOwner,
  NoCostPi,
} from "./fixtures/workspaceSessionCreation.js";

test("createWorkspaceSession rejects binding-kind mismatches before owner work", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-workspace-session-binding-kind-"));
  let host: ReturnType<typeof createAgentHostTarget> | undefined;
  let nativeOwner: ReturnType<typeof createSqliteNativeOwner> | undefined;
  try {
    const fixture = await createLinkedWorktreeFixture(root);
    const pi = new NoCostPi();
    const registry = new HarnessRegistry();
    registry.register(pi);
    nativeOwner = createSqliteNativeOwner(join(root, "native-sessions.sqlite"));
    host = createAgentHostTarget({
      root: join(root, "agent-host"),
      target: fixture.target,
      registry,
      worktrees: fixture.worktrees,
      admission: fixture.admission,
      nativeOwner: nativeOwner.port,
    });
    const base = {
      workspaceId: fixture.workspace.id,
      worktreeGeneration: fixture.workspace.worktreeGeneration,
    };
    const hostManaged = {
      kind: "host-managed" as const,
      selection: { providerId: "provider-pi", modelId: "model-pi" },
    };
    const nativeSelection = {
      kind: "native-selection" as const,
      selection: { providerId: "provider-native", modelId: "model-native" },
    };

    // native-v4 owner requires native-selection model binding.
    await assert.rejects(
      host.createWorkspaceSession({
        ...base,
        requestId: "binding-kind-native-rejects-host-managed",
        harnessId: "zcode",
        modelBinding: hostManaged,
      }),
      /native-workspace-session-requires-native-selection/,
    );

    // agent-host owner rejects native-selection model binding.
    await assert.rejects(
      host.createWorkspaceSession({
        ...base,
        requestId: "binding-kind-external-rejects-native-selection",
        harnessId: "pi",
        modelBinding: nativeSelection,
      }),
      /external-workspace-session-requires-external-model-binding/,
    );

    assert.equal(pi.creates, 0, "binding-kind reject must not create an external owner");
    assert.equal(pi.attaches, 0);
    assert.equal(pi.modelCalls, 0);
  } finally {
    await host?.close().catch(() => undefined);
    nativeOwner?.close();
    await rm(root, { recursive: true, force: true });
  }
});
