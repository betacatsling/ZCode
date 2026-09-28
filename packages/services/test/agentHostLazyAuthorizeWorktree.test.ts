import assert from "node:assert/strict";
import test from "node:test";
import type { SessionSpec } from "@zcode/shared/agent-host";
import type { IWorktreeService } from "../src/projectWorkspaceServices.js";
import { authorizeLazyWorktreeAdmission } from "../src/agent-host/lazyAuthorizeWorktree.js";

const PATH = "/tmp/zcode-wt-main";

function baseSpec(overrides: Partial<SessionSpec["execution"]> = {}): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId: "host-session-1",
    execution: {
      targetId: "local",
      workspaceIdentity: PATH,
      worktreePath: PATH,
      workspaceId: "ws-1",
      worktreeGeneration: "gen-1",
      ...overrides,
    },
    harness: { id: "pi", adapterVersion: "1" },
    modelBinding: { kind: "harness-managed" },
  };
}

function workspace(overrides: Record<string, unknown> = {}) {
  return {
    id: "ws-1",
    projectId: "proj-1",
    repositoryBindingId: "bind-1",
    title: "main",
    worktreePath: PATH,
    worktreeGeneration: "gen-1",
    workspaceIdentity: PATH,
    lifecycle: "active",
    verification: "verified",
    kind: "main",
    head: { kind: "branch", name: "main" },
    filesystemEvidence: {
      canonicalPath: PATH,
      device: null,
      inode: null,
      birthtimeMs: null,
    },
    ...overrides,
  };
}

function stubWorktrees(input: {
  catalogWorkspace?: ReturnType<typeof workspace> | undefined;
  revalidated?: {
    status: string;
    workspace: ReturnType<typeof workspace>;
  };
}): IWorktreeService {
  const catalogWs = input.catalogWorkspace;
  const revalidated =
    input.revalidated ??
    (catalogWs
      ? { status: "verified", workspace: catalogWs }
      : { status: "missing", workspace: workspace() });
  return {
    read: async () => ({
      schemaVersion: 1 as const,
      bindings: [],
      workspaces: catalogWs ? [catalogWs] : [],
      creationReceipts: [],
    }),
    revalidate: async () => revalidated,
  } as unknown as IWorktreeService;
}

test("authorizeLazyWorktreeAdmission rejects without worktrees or absolute path match", async () => {
  const spec = baseSpec();
  assert.equal(
    await authorizeLazyWorktreeAdmission({
      worktrees: undefined,
      targetId: "local",
      spec,
      realPath: PATH,
    }),
    false,
  );
  assert.equal(
    await authorizeLazyWorktreeAdmission({
      worktrees: stubWorktrees({ catalogWorkspace: workspace() }),
      targetId: "local",
      spec: baseSpec({ worktreePath: "relative/path" }),
      realPath: "relative/path",
    }),
    false,
  );
  assert.equal(
    await authorizeLazyWorktreeAdmission({
      worktrees: stubWorktrees({ catalogWorkspace: workspace() }),
      targetId: "local",
      spec,
      realPath: "/tmp/other",
    }),
    false,
  );
});

test("authorizeLazyWorktreeAdmission rejects stale worktreeGeneration after revalidate", async () => {
  const catalog = workspace({ worktreeGeneration: "gen-1" });
  const worktrees = stubWorktrees({
    catalogWorkspace: catalog,
    revalidated: {
      status: "verified",
      workspace: workspace({ worktreeGeneration: "gen-2" }),
    },
  });
  assert.equal(
    await authorizeLazyWorktreeAdmission({
      worktrees,
      targetId: "local",
      spec: baseSpec({ worktreeGeneration: "gen-1" }),
      realPath: PATH,
    }),
    false,
  );
});

test("authorizeLazyWorktreeAdmission rejects when catalog generation already drifts from spec", async () => {
  const catalog = workspace({ worktreeGeneration: "gen-stale-catalog" });
  assert.equal(
    await authorizeLazyWorktreeAdmission({
      worktrees: stubWorktrees({ catalogWorkspace: catalog }),
      targetId: "local",
      spec: baseSpec({ worktreeGeneration: "gen-1" }),
      realPath: PATH,
    }),
    false,
  );
});

test("authorizeLazyWorktreeAdmission admits verified matching generation", async () => {
  const catalog = workspace();
  assert.equal(
    await authorizeLazyWorktreeAdmission({
      worktrees: stubWorktrees({ catalogWorkspace: catalog }),
      targetId: "local",
      spec: baseSpec(),
      realPath: PATH,
    }),
    true,
  );
});
