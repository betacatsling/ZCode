import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProjectCatalog } from "../src/project-workspaces/projectCatalog.js";
import {
  ProjectCatalogTargetBridge,
  CatalogWorkspaceAdmission,
} from "../src/project-workspaces/targetBridge.js";
import { TargetWorktreeService } from "../src/project-workspaces/worktreeService.js";
import { createWorkspaceHierarchyService } from "../src/workspace-hierarchy/hierarchyService.js";
import { createRpcAgentHostService } from "../src/agent-host/rpcTargetService.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

test("real Git/catalog/target/Host: server derives identity and deduplicates creation commands", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hierarchy-service-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q");
  git(
    repo,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "base",
  );
  const execution = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  let activeRuns = 0;
  const target = await TargetWorktreeService.open({
    storageDirectory: path.join(root, "target"),
    executionTargetId: "local",
    activity: async () => ({
      running: activeRuns,
      waiting: 0,
      tools: 0,
      uncertain: 0,
      offline: false,
    }),
  });
  let catalog!: ProjectCatalog;
  let rpc: ReturnType<typeof createRpcAgentHostService> | undefined;
  let host: AgentHostTargetService | undefined;
  try {
    const index = {
      async allSessions() {
        return [];
      },
      async workspaceFreshness() {
        return "live" as const;
      },
    };
    catalog = await ProjectCatalog.open(
      path.join(root, "catalog.json"),
      new ProjectCatalogTargetBridge(target, "local", (_id, cwd) => cwd),
      index,
    );
    await catalog.importProject({
      id: "p",
      bindingId: "b",
      targetId: "local",
      name: "Repo",
      repositoryPath: repo,
    });
    const workspace = await catalog.adopt({
      bindingId: "b",
      workspaceId: "w",
      title: "Main",
      worktreePath: repo,
    });
    const harnesses = new HarnessRegistry();
    harnesses.registerTrusted(
      { schemaVersion: 1, id: "mock", name: "Mock", adapterVersion: "1.0.0" },
      () => new MockHarness(),
    );
    const gate = new CatalogWorkspaceAdmission(catalog, target, "local");
    host = new AgentHostTargetService({
      root: path.join(root, "host"),
      target: execution,
      registry: harnesses,
      catalog: {
        fingerprint: "fixture",
        validateSelection: () => ({ ok: false as const, reason: "no external model" }),
      },
      admission: {
        verify: (spec) => gate.verify(spec),
        withAdmission: (spec, action) =>
          gate.withAdmission(spec, (canonicalCwd) => action({ canonicalCwd })),
      },
    });
    rpc = createRpcAgentHostService(host, () => true);
    const hierarchy = createWorkspaceHierarchyService({
      targetId: "local",
      catalog,
      host: rpc.service,
      newAdmissionsEnabled: () => true,
    });
    const initialPreview = await hierarchy.previewRemoval({
      workspaceId: "w",
      expectedGeneration: workspace.worktreeGeneration,
    });
    assert.equal(initialPreview.safe, false); // main checkout is never removable
    assert.equal(initialPreview.git?.isMain, true);
    const linkedPath = path.join(root, "linked");
    git(repo, "worktree", "add", "-q", "-b", "test-linked", linkedPath);
    const linked = await catalog.adopt({
      bindingId: "b",
      workspaceId: "linked",
      title: "Linked",
      worktreePath: linkedPath,
    });
    const linkedPreview = await hierarchy.previewRemoval({
      workspaceId: "linked",
      expectedGeneration: linked.worktreeGeneration,
    });
    assert.equal(linkedPreview.safe, true);
    await writeFile(path.join(linkedPath, "new-untracked.txt"), "untracked\n");
    const untracked = await hierarchy.previewRemoval({
      workspaceId: "linked",
      expectedGeneration: linked.worktreeGeneration,
    });
    assert.equal(untracked.git?.untracked, true);
    assert.equal(untracked.safe, false);
    await rm(path.join(linkedPath, "new-untracked.txt"));
    activeRuns = 1;
    const running = await hierarchy.previewRemoval({
      workspaceId: "linked",
      expectedGeneration: linked.worktreeGeneration,
    });
    assert.equal(running.activity?.running, 1);
    assert.equal(running.safe, false);
    activeRuns = 0;
    await assert.rejects(
      hierarchy.previewRemoval({ workspaceId: "w", expectedGeneration: "recreated" }),
      /stale/,
    );
    assert.equal((await hierarchy.pendingRecovery({ workspaceId: "w" })).status, "unresolved");
    await assert.rejects(hierarchy.pendingRecovery({ workspaceId: "missing" }), /Unknown/);
    assert.equal(
      (
        await hierarchy.resolveWorkspace({
          targetId: "local",
          workspacePath: workspace.worktreePath,
        })
      )?.workspaceId,
      "w",
    );
    assert.equal(
      await hierarchy.resolveWorkspace({
        targetId: "foreign",
        workspacePath: workspace.worktreePath,
      }),
      undefined,
    );
    assert.equal(
      await hierarchy.resolveWorkspace({
        targetId: "local",
        workspacePath: workspace.worktreePath,
        remoteSessionId: "untrusted",
      }),
      undefined,
    );
    assert.equal(
      await hierarchy.resolveOwner({ targetId: "local", workspaceId: "w", sessionId: "missing" }),
      undefined,
    );
    const intent = {
      workspaceId: workspace.id,
      harnessId: "mock",
      commandId: "creation-one",
      modelBinding: { kind: "harness-managed" as const },
    };
    const [first, repeat] = await Promise.all([
      hierarchy.createAgent(intent),
      hierarchy.createAgent(intent),
    ]);
    assert.equal(first.owner.kind, "external");
    assert.deepEqual(repeat.owner, first.owner);
    if (first.owner.kind !== "external") throw new Error("wrong owner");
    assert.equal(first.owner.spec.execution.worktreeGeneration, workspace.worktreeGeneration);
    assert.equal(first.owner.spec.execution.worktreePath, workspace.worktreePath);
    // 中文：同一路径重新登记为新 worktree，不可将旧 Host spec 重新绑定到执行入口。
    const rebuiltCatalog = {
      previewRemoval: (id: string, generation: string) => catalog.previewRemoval(id, generation),
      sidebarSnapshot: async () => ({
        ...(await catalog.sidebarSnapshot()),
        workspaces: (await catalog.sidebarSnapshot()).workspaces.map((row) =>
          row.id === "w" ? { ...row, worktreeGeneration: "new-instance" } : row,
        ),
      }),
    };
    const rebuilt = createWorkspaceHierarchyService({
      targetId: "local",
      catalog: rebuiltCatalog,
      host: rpc.service,
      newAdmissionsEnabled: () => true,
    });
    const stale = await rebuilt.resolveOwner({
      targetId: "local",
      workspaceId: "w",
      sessionId: first.owner.spec.hostSessionId,
    });
    assert.equal(stale?.kind, "external");
    if (stale?.kind !== "external") throw new Error("missing old owner");
    assert.equal(stale.historyOnly, true);
    assert.equal(stale.spec.execution.worktreeGeneration, workspace.worktreeGeneration);
    const changedBinding = createWorkspaceHierarchyService({
      targetId: "local",
      catalog: {
        previewRemoval: (id, generation) => catalog.previewRemoval(id, generation),
        sidebarSnapshot: async () => {
          const snapshot = await catalog.sidebarSnapshot();
          return {
            ...snapshot,
            bindings: snapshot.bindings.map((row) =>
              row.id === "b" ? { ...row, projectId: "another-project" } : row,
            ),
          };
        },
      },
      host: rpc.service,
      newAdmissionsEnabled: () => true,
    });
    assert.equal(
      (
        await changedBinding.resolveOwner({
          targetId: "local",
          workspaceId: "w",
          sessionId: first.owner.spec.hostSessionId,
        })
      )?.historyOnly,
      true,
    );
    await assert.rejects(
      changedBinding.previewRemoval({
        workspaceId: "w",
        expectedGeneration: workspace.worktreeGeneration,
      }),
      /Unknown target workspace/,
    );

    assert.equal(
      (
        await hierarchy.resolveOwner({
          targetId: "local",
          workspaceId: "w",
          sessionId: first.owner.spec.hostSessionId,
        })
      )?.kind,
      "external",
    );
    const mapped = createWorkspaceHierarchyService({
      targetId: "local",
      catalog,
      host: rpc.service,
      newAdmissionsEnabled: () => true,
      native: {
        resolveOwner: async ({ sessionId }) =>
          sessionId === "tree-alias"
            ? {
                originalSessionId: "original-v4-id",
                sourceWorkspacePath: repo,
                workspaceIdentity: workspace.workspaceIdentity,
              }
            : undefined,
        create: async () => {
          throw new Error("native creation belongs to V4 owner");
        },
        capabilities: async () => {
          throw new Error("not a native runtime fixture");
        },
      },
      resolveRemoteSession: async () => "attached-remote-session",
    });
    const native = await mapped.resolveOwner({
      targetId: "local",
      workspaceId: "w",
      sessionId: "tree-alias",
    });
    assert.equal(native?.kind, "native");
    if (native?.kind !== "native") throw new Error("missing native mapping");
    assert.equal(native.originalSessionId, "original-v4-id");
    assert.equal(native.scope.workspacePath, repo);
    assert.equal(native.historyOnly, true); // legacy owner has no signed generation/binding
    const nativeRebuilt = createWorkspaceHierarchyService({
      targetId: "local",
      catalog: rebuiltCatalog,
      host: rpc.service,
      newAdmissionsEnabled: () => true,
      native: {
        resolveOwner: async () => ({
          originalSessionId: "original-v4-id",
          sourceWorkspacePath: repo,
          workspaceIdentity: workspace.workspaceIdentity,
          repositoryBindingId: "b",
          worktreeGeneration: workspace.worktreeGeneration,
        }),
        create: async () => {
          throw new Error("not a native fixture");
        },
        capabilities: async () => {
          throw new Error("not a native fixture");
        },
      },
    });
    assert.equal(
      (
        await nativeRebuilt.resolveOwner({
          targetId: "local",
          workspaceId: "w",
          sessionId: "tree-alias",
        })
      )?.historyOnly,
      true,
    );
    const nativeMatching = createWorkspaceHierarchyService({
      targetId: "local",
      catalog,
      host: rpc.service,
      newAdmissionsEnabled: () => true,
      native: {
        resolveOwner: async () => ({
          originalSessionId: "original-v4-id",
          sourceWorkspacePath: repo,
          workspaceIdentity: workspace.workspaceIdentity,
          repositoryBindingId: "b",
          worktreeGeneration: workspace.worktreeGeneration,
        }),
        create: async () => {
          throw new Error("not a native fixture");
        },
        capabilities: async () => {
          throw new Error("not a native fixture");
        },
      },
    });
    assert.equal(
      (
        await nativeMatching.resolveOwner({
          targetId: "local",
          workspaceId: "w",
          sessionId: "tree-alias",
        })
      )?.historyOnly,
      false,
    );

    assert.equal(
      (
        await mapped.resolveWorkspace({
          targetId: "local",
          workspacePath: workspace.worktreePath,
          remoteSessionId: "attached-remote-session",
        })
      )?.remoteSessionId,
      "attached-remote-session",
    );
    assert.equal(
      await mapped.resolveWorkspace({
        targetId: "local",
        workspacePath: workspace.worktreePath,
        remoteSessionId: "spoofed",
      }),
      undefined,
    );
    await assert.rejects(hierarchy.createAgent({ ...intent, harnessId: "unknown" }), /intent/);
    assert.equal((await hierarchy.createAgent(intent)).owner.kind, "external");
    await assert.rejects(
      hierarchy.createAgent({ ...intent, commandId: "different", harnessId: "unknown" }),
      /harness/,
    );
    await assert.rejects(
      hierarchy.createAgent({
        ...intent,
        commandId: "invalid-cwd",
        cwdRelativeToWorktree: "../escape",
      }),
      /cwd/,
    );
  } finally {
    rpc?.dispose();
    await host?.close();
    await catalog?.close();
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});
