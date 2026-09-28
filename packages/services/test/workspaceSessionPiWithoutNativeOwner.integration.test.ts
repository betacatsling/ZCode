import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createCurrentOwnerSessionSource } from "../src/session-hierarchy/app/currentOwnerSource.js";
import { createSessionHierarchyService } from "../src/session-hierarchy/app/service.js";
import { createSessionHierarchyFilePersistence } from "../src/session-hierarchy/adapters/filePersistence.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import {
  catalog,
  createAgentHostTarget,
  createLinkedWorktreeFixture,
  NoCostPi,
  targetId,
} from "./fixtures/workspaceSessionCreation.js";

test("Pi creation and current membership do not require or bootstrap a Native owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-pi-without-native-owner-"));
  let host: ReturnType<typeof createAgentHostTarget> | undefined;
  try {
    const fixture = await createLinkedWorktreeFixture(root);
    const pi = new NoCostPi();
    const registry = new HarnessRegistry();
    registry.register(pi);
    // No native owner capability is passed to this real Host service instance.
    host = createAgentHostTarget({
      root: join(root, "agent-host"),
      target: fixture.target,
      registry,
      worktrees: fixture.worktrees,
      admission: fixture.admission,
    });
    const request = {
      requestId: "pi-without-native-owner",
      workspaceId: fixture.workspace.id,
      worktreeGeneration: fixture.workspace.worktreeGeneration,
      harnessId: "pi",
      modelBinding: {
        kind: "host-managed" as const,
        selection: { providerId: "provider-pi", modelId: "model-pi" },
      },
      title: "Pi without Native",
    };
    const created = await host.createWorkspaceSession(request);
    assert.equal(created.locator.ownerKind, "agent-host");
    assert.equal(pi.creates, 1);
    assert.equal(pi.attaches, 0);
    assert.equal(pi.modelCalls, 0);

    const hierarchy = createSessionHierarchyService({
      index: {
        async listPersistedSessionLocators() {
          throw new Error("current membership must not read legacy TaskIndex");
        },
      },
      currentOwners: createCurrentOwnerSessionSource(host),
      worktrees: {
        async read() {
          const current = await fixture.worktrees.read();
          return {
            workspaces: current.workspaces.map((workspace) => ({
              targetId,
              projectId: workspace.projectId,
              workspaceId: workspace.id,
              worktreePath: workspace.worktreePath,
              worktreeGeneration: workspace.worktreeGeneration,
              ...(workspace.workspaceIdentity
                ? { workspaceIdentity: workspace.workspaceIdentity }
                : {}),
              lifecycle: workspace.lifecycle,
              verification: workspace.verification,
            })),
          };
        },
      },
      persistence: createSessionHierarchyFilePersistence(join(root, "hierarchy.json")),
      targetId: () => targetId,
      knownHarnessIds: ["zcode", "pi"],
    });
    const current = await hierarchy.read();
    assert.equal(current?.records.length, 1);
    assert.equal(current?.records[0]?.nativeSessionId, created.locator.sessionId);
    assert.equal(
      current?.records[0]?.ownerAssociation?.worktreeGeneration,
      fixture.workspace.worktreeGeneration,
    );
    assert.equal(pi.creates, 1, "current membership read must not attach another Pi owner");
    assert.equal(pi.attaches, 0);
    assert.equal(pi.modelCalls, 0);

    assert.equal(
      (await host.createWorkspaceSession(request)).locator.sessionId,
      created.locator.sessionId,
    );
    assert.equal(pi.creates, 1);
    await assert.rejects(
      host.createWorkspaceSession({
        ...request,
        harnessId: "zcode",
        modelBinding: {
          kind: "native-selection",
          selection: { providerId: "provider-native", modelId: "model-native" },
        },
      }),
      /idempotency-conflict/,
    );
    assert.equal(pi.creates, 1);
  } finally {
    await host?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
