import assert from "node:assert/strict";
import { test } from "node:test";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";

test("trusted remote scope isolates equal paths and refuses stale generations before effects", async () => {
  let nextId = 0;
  const firstServices = { owner: "target-Core-a" };
  const secondServices = { owner: "target-Core-b" };
  const registry = createWindowRemoteConnectionRegistry({
    createId: () => `session-${++nextId}`,
    connect: async ({ target }) => ({
      services:
        target.kind === "docker" && target.container === "fixture-a"
          ? firstServices
          : secondServices,
      dispose() {},
    }),
  });
  try {
    const first = await registry.connect({
      requestId: "first",
      target: { kind: "docker", container: "fixture-a" },
      remoteAssets: {},
      workspacePath: "/same",
      workspaceIdentity: "remote:a",
    });
    const second = await registry.connect({
      requestId: "second",
      target: { kind: "docker", container: "fixture-b" },
      remoteAssets: {},
      workspacePath: "/same",
      workspaceIdentity: "remote:b",
    });
    const scope = {
      kind: "remote" as const,
      remoteSessionId: first.remoteSessionId,
      workspacePath: "/same",
      workspaceIdentity: "remote:a",
    };
    let effects = 0;
    await assert.rejects(
      registry.withCurrentScopedServices(
        { ...scope, workspaceIdentity: "remote:b" },
        first.generation,
        async () => {
          effects++;
        },
      ),
      /scope|匹配/,
    );
    await assert.rejects(
      registry.withCurrentScopedServices(
        { ...scope, remoteSessionId: second.remoteSessionId },
        first.generation,
        async () => {
          effects++;
        },
      ),
      /scope|匹配/,
    );
    assert.equal(effects, 0);
    const committed = await registry.withCurrentScopedServices(
      scope,
      first.generation,
      async (target, lease) => {
        effects++;
        assert.equal(target, firstServices);
        assert.equal(lease.remoteSessionId, first.remoteSessionId);
        return "committed-id";
      },
    );
    assert.deepEqual(committed, { status: "committed", value: "committed-id" });
    assert.deepEqual(
      await registry.withCurrentScopedServices(
        { ...scope, remoteSessionId: second.remoteSessionId, workspaceIdentity: "remote:b" },
        second.generation,
        async (target) => target.owner,
      ),
      { status: "committed", value: "target-Core-b" },
    );

    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = registry.withCurrentScopedServices(scope, first.generation, async () => {
      effects++;
      await barrier;
      return "may-have-committed";
    });
    await registry.bindWorkspaceContext({
      remoteSessionId: first.remoteSessionId,
      workspacePath: "/same",
      workspaceIdentity: "remote:a",
    });
    release();
    assert.deepEqual(await pending, {
      status: "uncertain",
      recovery: "query-by-stable-command-id",
    });
    assert.equal(effects, 2);
    await assert.rejects(
      registry.withCurrentScopedServices(scope, first.generation, async () => {
        effects++;
      }),
      /generation mismatch/,
    );
    assert.equal(effects, 2);
    assert.equal(
      registry.findSessionForWorkspace({ workspacePath: "/same", workspaceIdentity: "remote:b" })
        ?.remoteSessionId,
      second.remoteSessionId,
    );
  } finally {
    await registry.dispose();
  }
});
