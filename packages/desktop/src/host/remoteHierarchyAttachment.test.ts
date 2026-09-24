import assert from "node:assert/strict";
import { test } from "node:test";
import { IAgentHostService, IWorkspaceHierarchyService, ServiceCollection } from "@zcode/services";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";
import {
  createRemoteHierarchyAttachment,
  RemoteCreateUncertainError,
} from "./remoteHierarchyAttachment.js";

function scopedServices(hierarchy: IWorkspaceHierarchyService) {
  return new ServiceCollection()
    .register(IWorkspaceHierarchyService, hierarchy)
    .register(IAgentHostService, {
      getAvailability: async () => ({ target: { available: true, id: "target-a" } }),
    } as unknown as IAgentHostService);
}

test("remote hierarchy create resolves validated target service, rejects cross-identity and stale renewal", async () => {
  let calls = 0;
  const scope = {
    kind: "remote" as const,
    remoteSessionId: "session-1",
    workspacePath: "/same",
    workspaceIdentity: "remote:a",
  };
  const owner = {
    kind: "native" as const,
    scope: {
      workspaceId: "work",
      targetId: "target-a",
      workspaceIdentity: "remote:a",
      workspacePath: "/same",
    },
    originalSessionId: "original",
    historyOnly: false,
  };
  const agent = {
    resolveWorkspace: async () => ({
      workspaceId: "work",
      targetId: "target-a",
      workspaceIdentity: "remote:a",
      workspacePath: "/same",
      remoteSessionId: "session-1",
    }),
    createAgent: async () => {
      calls++;
      return { owner };
    },
  } as unknown as IWorkspaceHierarchyService;
  const other = {
    createAgent: async () => {
      calls++;
      throw new Error("wrong target");
    },
  } as unknown as IWorkspaceHierarchyService;
  const registry = createWindowRemoteConnectionRegistry<ServiceCollection>({
    createId: (() => {
      let n = 0;
      return () => `session-${++n}`;
    })(),
    connect: async ({ target }) => ({
      services: scopedServices(
        target.kind === "docker" && target.container === "a" ? agent : other,
      ),
      dispose() {},
    }),
  });
  try {
    const a = await registry.connect({
      requestId: "a",
      target: { kind: "docker", container: "a" },
      remoteAssets: {},
      workspacePath: "/same",
      workspaceIdentity: "remote:a",
    });
    await registry.connect({
      requestId: "b",
      target: { kind: "docker", container: "b" },
      remoteAssets: {},
      workspacePath: "/same",
      workspaceIdentity: "remote:b",
    });
    assert.equal(a.remoteSessionId, scope.remoteSessionId);
    const routed = createRemoteHierarchyAttachment(other, scope, (action) =>
      registry.withCurrentScopedServices(scope, a.generation, (services, lease) =>
        action(services, lease.assertCurrent),
      ),
    );
    const request = {
      workspaceId: "work",
      harnessId: "native",
      modelBinding: {
        kind: "host-managed" as const,
        selection: { providerId: "fake", modelId: "fake" },
      },
      commandId: "stable",
    } as Parameters<IWorkspaceHierarchyService["createAgent"]>[0];
    assert.equal(
      (await routed.createAgent(request)).owner.scope.remoteSessionId,
      scope.remoteSessionId,
    );
    assert.equal(calls, 1);
    await registry.bindWorkspaceContext({
      remoteSessionId: scope.remoteSessionId,
      workspacePath: "/same",
      workspaceIdentity: "remote:a",
    });
    await assert.rejects(routed.createAgent(request), /generation mismatch/);
    assert.equal(calls, 1);
  } finally {
    await registry.dispose();
  }
});

test("a foreign workspace ID is rejected before the target can allocate", async () => {
  const scope = {
    kind: "remote" as const,
    remoteSessionId: "s",
    workspacePath: "/same",
    workspaceIdentity: "remote:a",
  };
  let calls = 0;
  const hierarchy = {
    resolveWorkspace: async () => ({
      workspaceId: "foreign-workspace",
      targetId: "target-a",
      workspaceIdentity: "remote:b",
      workspacePath: "/same",
    }),
    createAgent: async () => {
      calls++;
      return {
        owner: {
          kind: "native" as const,
          scope: {
            workspacePath: "/same",
            workspaceIdentity: "remote:a",
            workspaceId: "foreign-workspace",
            targetId: "t",
          },
          originalSessionId: "id",
          historyOnly: false,
        },
      };
    },
  } as unknown as IWorkspaceHierarchyService;
  const routed = createRemoteHierarchyAttachment(hierarchy, scope, async (action) => ({
    status: "committed",
    value: await action(scopedServices(hierarchy), () => {}),
  }));
  await assert.rejects(
    routed.createAgent({ commandId: "stable", workspaceId: "expected-workspace" } as Parameters<
      IWorkspaceHierarchyService["createAgent"]
    >[0]),
    /Remote target scope denied/,
  );
  assert.equal(calls, 0);
});

test("async catalog lookup followed by lease rotation never reaches target create", async () => {
  const scope = {
    kind: "remote" as const,
    remoteSessionId: "session-1",
    workspacePath: "/same",
    workspaceIdentity: "remote:a",
  };
  let createCalls = 0;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const hierarchy = {
    resolveWorkspace: async () => ({
      workspaceId: "work",
      targetId: "target-a",
      workspaceIdentity: "remote:a",
      workspacePath: "/same",
    }),
    createAgent: async () => {
      createCalls++;
      throw new Error("must not allocate");
    },
  } as unknown as IWorkspaceHierarchyService;
  const host = {
    getAvailability: async () => {
      started();
      await gate;
      return { target: { available: true, id: "target-a" } };
    },
  } as unknown as IAgentHostService;
  const registry = createWindowRemoteConnectionRegistry<ServiceCollection>({
    createId: () => "session-1",
    connect: async () => ({
      services: new ServiceCollection()
        .register(IWorkspaceHierarchyService, hierarchy)
        .register(IAgentHostService, host),
      dispose() {},
    }),
  });
  try {
    const session = await registry.connect({
      requestId: "a",
      target: { kind: "docker", container: "a" },
      remoteAssets: {},
      workspacePath: "/same",
      workspaceIdentity: "remote:a",
    });
    const routed = createRemoteHierarchyAttachment(hierarchy, scope, (action) =>
      registry.withCurrentScopedServices(scope, session.generation, (services, lease) =>
        action(services, lease.assertCurrent),
      ),
    );
    const pending = routed.createAgent({ workspaceId: "work", commandId: "stable" } as Parameters<
      IWorkspaceHierarchyService["createAgent"]
    >[0]);
    await entered;
    await registry.bindWorkspaceContext({
      remoteSessionId: session.remoteSessionId,
      workspacePath: "/same",
      workspaceIdentity: "remote:a",
    });
    release();
    await assert.rejects(pending, RemoteCreateUncertainError);
    assert.equal(createCalls, 0);
  } finally {
    release();
    await registry.dispose();
  }
});

test("post-admission lease change reports uncertainty and never resends", async () => {
  const scope = {
    kind: "remote" as const,
    remoteSessionId: "s",
    workspacePath: "/same",
    workspaceIdentity: "remote:a",
  };
  let calls = 0;
  const hierarchy = {
    resolveWorkspace: async () => ({
      workspaceId: "w",
      targetId: "target-a",
      workspaceIdentity: "remote:a",
      workspacePath: "/same",
      remoteSessionId: "s",
    }),
    createAgent: async () => {
      calls++;
      return {
        owner: {
          kind: "native" as const,
          scope: {
            workspacePath: "/same",
            workspaceIdentity: "remote:a",
            workspaceId: "w",
            targetId: "t",
          },
          originalSessionId: "id",
          historyOnly: false,
        },
      };
    },
  } as unknown as IWorkspaceHierarchyService;
  const routed = createRemoteHierarchyAttachment(hierarchy, scope, async (action) => {
    await action(scopedServices(hierarchy), () => {});
    return { status: "uncertain", recovery: "query-by-stable-command-id" };
  });
  await assert.rejects(
    routed.createAgent({ commandId: "stable", workspaceId: "w" } as Parameters<
      IWorkspaceHierarchyService["createAgent"]
    >[0]),
    RemoteCreateUncertainError,
  );
  assert.equal(calls, 1);
});
