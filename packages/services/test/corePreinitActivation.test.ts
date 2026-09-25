import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ProviderRegistryService } from "@zcode/provider";
import type { SessionSpecV2 } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";
import { createLazyTargetAgentHostService } from "../src/agent-host/lazyTargetService.js";

test("held external attach cannot activate the real Host adapter before a workspace lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "core-preinit-host-"));
  const path = join(root, "tree");
  await mkdir(path);
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const spec: SessionSpecV2 = {
    schemaVersion: 2,
    hostSessionId: "accepted",
    projectId: "p",
    workspaceId: "w",
    execution: {
      targetId: "local",
      workspaceIdentity: "identity",
      worktreePath: path,
      worktreeGeneration: "generation-1",
      cwdRelativeToWorktree: ".",
    },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: { kind: "host-managed", selection: { providerId: "provider", modelId: "model" } },
  };
  const admission = {
    verify: async () => ({ canonicalCwd: path }),
    withAdmission: async <T>(
      _candidate: SessionSpecV2,
      action: (verified: { canonicalCwd: string }) => Promise<T>,
    ) => action({ canonicalCwd: path }),
  };
  const registry = new HarnessRegistry();
  const mock = new MockHarness();
  registry.registerTrusted(
    { schemaVersion: 1, id: "mock", name: "Mock", adapterVersion: "1.0.0" },
    () => mock,
  );
  const prior = new AgentHostTargetService({
    root: join(root, "sessions"),
    target,
    registry,
    admission,
    catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true as const }) },
  });
  let lazy: ReturnType<typeof createLazyTargetAgentHostService> | undefined;
  try {
    // This is a genuine durable Host creation, not an invented journal or callback-only business queue.
    await prior.create(spec, "created-through-host");
    await prior.close();
    let open = false;
    let registryStarts = 0;
    lazy = createLazyTargetAgentHostService({
      root,
      target,
      allowNewSessions: () => open,
      registry: {
        start: async () => {
          registryStarts++;
        },
        getSnapshot: () => ({
          registry: { providers: [] },
          sourceRevisions: { config: "fixture", account: "fixture" },
        }),
      } as unknown as ProviderRegistryService,
      additionalTrustedHarnesses: [
        {
          manifest: { schemaVersion: 1, id: "mock", name: "Mock", adapterVersion: "1.0.0" },
          factory: () => new MockHarness(),
        },
      ],
      admission: {
        verify: admission.verify,
        withAdmission: async <T>(
          candidate: SessionSpecV2,
          action: (verified: { canonicalCwd: string }) => Promise<T>,
        ) => {
          if (!open) throw new Error("held workspace admission");
          return admission.withAdmission(candidate, action);
        },
      },
    });
    assert.equal(
      (await lazy.service.queryCreationCommand("created-through-host"))?.receipt.status,
      "completed",
    );
    await assert.rejects(lazy.service.attach(spec), /disabled|held/);
    assert.equal(registryStarts, 0, "no lazy adapter/Registry activation while held");
    assert.equal((await lazy.service.listWorkspaceSessions("w")).length, 1);
    open = true;
    const fresh = {
      ...spec,
      hostSessionId: "fresh",
      modelBinding: { kind: "harness-managed" as const },
    };
    const created = await lazy.service.create(fresh, "fresh-command");
    assert.equal(created.sessionId, "fresh");
    assert.equal(registryStarts, 1);
    assert.equal(
      (await lazy.service.queryCreationCommand("fresh-command"))?.receipt.status,
      "completed",
    );
  } finally {
    await lazy?.dispose();
    await prior.close();
    await rm(root, { recursive: true, force: true });
  }
});
