import assert from "node:assert/strict";
import { test } from "node:test";
import { IWorkspaceHierarchyService, ServiceCollection } from "@zcode/services";
import { createWindowRemoteConnectionRegistry } from "./windowRemoteConnectionRegistry.js";
import {
  createRemoteHierarchyAttachment,
  RemoteCreateUncertainError,
} from "./remoteHierarchyAttachment.js";

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
      services: new ServiceCollection().register(
        IWorkspaceHierarchyService,
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
      registry.withCurrentScopedServices(scope, a.generation, (services) => action(services)),
    );
    const request = {
      workspaceId: "work",
      harnessId: "native",
      modelBinding: {
        kind: "host-managed" as const,
        selection: { providerName: "fake", modelId: "fake" },
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

test("a target response for another workspace is uncertain, not writable or retried", async () => {
  const scope = {
    kind: "remote" as const,
    remoteSessionId: "s",
    workspacePath: "/same",
    workspaceIdentity: "remote:a",
  };
  let calls = 0;
  const hierarchy = {
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
    value: await action(new ServiceCollection().register(IWorkspaceHierarchyService, hierarchy)),
  }));
  await assert.rejects(
    routed.createAgent({ commandId: "stable", workspaceId: "expected-workspace" } as Parameters<
      IWorkspaceHierarchyService["createAgent"]
    >[0]),
    RemoteCreateUncertainError,
  );
  assert.equal(calls, 1);
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
    await action(new ServiceCollection().register(IWorkspaceHierarchyService, hierarchy));
    return { status: "uncertain", recovery: "query-by-stable-command-id" };
  });
  await assert.rejects(
    routed.createAgent({ commandId: "stable" } as Parameters<
      IWorkspaceHierarchyService["createAgent"]
    >[0]),
    RemoteCreateUncertainError,
  );
  assert.equal(calls, 1);
});
