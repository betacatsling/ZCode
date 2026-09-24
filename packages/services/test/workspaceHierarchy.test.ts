import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ProjectCatalog } from "../src/project-workspaces/projectCatalog.js";
import { ProjectCatalogTargetBridge, CatalogWorkspaceAdmission } from "../src/project-workspaces/targetBridge.js";
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
  git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "--allow-empty", "-m", "base");
  const execution = { id: "local", kind: "local" as const, platform: process.platform as "darwin" | "linux" | "win32", available: true };
  const target = await TargetWorktreeService.open({ storageDirectory: path.join(root, "target"),
    executionTargetId: "local", activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }) });
  let catalog!: ProjectCatalog;
  let rpc: ReturnType<typeof createRpcAgentHostService> | undefined;
  let host: AgentHostTargetService | undefined;
  try {
    const index = { async allSessions() { return []; }, async workspaceFreshness() { return "live" as const; } };
    catalog = await ProjectCatalog.open(path.join(root, "catalog.json"), new ProjectCatalogTargetBridge(target, "local", (_id, cwd) => cwd), index);
    await catalog.importProject({ id: "p", bindingId: "b", targetId: "local", name: "Repo", repositoryPath: repo });
    const workspace = await catalog.adopt({ bindingId: "b", workspaceId: "w", title: "Main", worktreePath: repo });
    const harnesses = new HarnessRegistry();
    harnesses.registerTrusted({ schemaVersion: 1, id: "mock", name: "Mock", adapterVersion: "1.0.0" }, () => new MockHarness());
    const gate = new CatalogWorkspaceAdmission(catalog, target, "local");
    host = new AgentHostTargetService({ root: path.join(root, "host"), target: execution, registry: harnesses,
      catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: false as const, reason: "no external model" }) },
      admission: { verify: (spec) => gate.verify(spec),
        withAdmission: (spec, action) => gate.withAdmission(spec, (canonicalCwd) => action({ canonicalCwd })) },
    });
    rpc = createRpcAgentHostService(host, () => true);
    const hierarchy = createWorkspaceHierarchyService({ targetId: "local", catalog, host: rpc.service,
      newAdmissionsEnabled: () => true });
    assert.equal((await hierarchy.resolveWorkspace({ targetId: "local", workspacePath: workspace.worktreePath }))?.workspaceId, "w");
    assert.equal(await hierarchy.resolveWorkspace({ targetId: "foreign", workspacePath: workspace.worktreePath }), undefined);
    assert.equal(await hierarchy.resolveWorkspace({ targetId: "local", workspacePath: workspace.worktreePath, remoteSessionId: "untrusted" }), undefined);
    assert.equal(await hierarchy.resolveOwner({ targetId: "local", workspaceId: "w", sessionId: "missing" }), undefined);
    const intent = { workspaceId: workspace.id, harnessId: "mock", commandId: "creation-one",
      modelBinding: { kind: "harness-managed" as const } };
    const [first, repeat] = await Promise.all([hierarchy.createAgent(intent), hierarchy.createAgent(intent)]);
    assert.equal(first.owner.kind, "external");
    assert.deepEqual(repeat.owner, first.owner);
    if (first.owner.kind !== "external") throw new Error("wrong owner");
    assert.equal(first.owner.spec.execution.worktreeGeneration, workspace.worktreeGeneration);
    assert.equal(first.owner.spec.execution.worktreePath, workspace.worktreePath);
    assert.equal((await hierarchy.resolveOwner({ targetId: "local", workspaceId: "w", sessionId: first.owner.spec.hostSessionId }))?.kind, "external");
    const mapped = createWorkspaceHierarchyService({ targetId: "local", catalog, host: rpc.service,
      newAdmissionsEnabled: () => true,
      native: {
        resolveOwner: async ({ sessionId }) => sessionId === "tree-alias" ? {
          originalSessionId: "original-v4-id", sourceWorkspacePath: repo,
          workspaceIdentity: workspace.workspaceIdentity,
        } : undefined,
        create: async () => { throw new Error("native creation belongs to V4 owner"); },
        capabilities: async () => { throw new Error("not a native runtime fixture"); },
      },
      resolveRemoteSession: async () => "attached-remote-session",
    });
    const native = await mapped.resolveOwner({ targetId: "local", workspaceId: "w", sessionId: "tree-alias" });
    assert.equal(native?.kind, "native");
    if (native?.kind !== "native") throw new Error("missing native mapping");
    assert.equal(native.originalSessionId, "original-v4-id");
    assert.equal(native.scope.workspacePath, repo);
    assert.equal((await mapped.resolveWorkspace({ targetId: "local", workspacePath: workspace.worktreePath,
      remoteSessionId: "attached-remote-session" }))?.remoteSessionId, "attached-remote-session");
    assert.equal(await mapped.resolveWorkspace({ targetId: "local", workspacePath: workspace.worktreePath,
      remoteSessionId: "spoofed" }), undefined);
    await assert.rejects(hierarchy.createAgent({ ...intent, harnessId: "unknown" }), /intent/);
    assert.equal((await hierarchy.createAgent(intent)).owner.kind, "external");
    await assert.rejects(hierarchy.createAgent({ ...intent, commandId: "different", harnessId: "unknown" }), /harness/);
    await assert.rejects(hierarchy.createAgent({ ...intent, commandId: "invalid-cwd", cwdRelativeToWorktree: "../escape" }), /cwd/);
  } finally {
    rpc?.dispose();
    await host?.close();
    await catalog?.close();
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});
