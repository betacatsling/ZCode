import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ProjectCatalogTargetSnapshot } from "@zcode/shared/agent-host";
import {
  createFileProjectCatalogService,
  projectCatalogFileSchema,
} from "../src/project-catalog/index.js";
import { createFileWorktreeService, type IWorktreeService } from "../src/worktree/index.js";

const execFile = promisify(execFileCallback);

async function git(args: readonly string[]): Promise<string> {
  const result = await execFile("git", args, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function withRoot<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "zcode-project-catalog-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withCatalog<T>(run: (filePath: string) => Promise<T>): Promise<T> {
  return withRoot((root) => run(join(root, "project-catalog.json")));
}

async function createRepository(root: string): Promise<string> {
  const repositoryPath = join(root, "shared path with spaces");
  await git(["init", "-q", repositoryPath]);
  await git(["-C", repositoryPath, "config", "user.email", "test@example.com"]);
  await git(["-C", repositoryPath, "config", "user.name", "Catalog Test"]);
  await writeFile(join(repositoryPath, "README.md"), "catalog\n", "utf8");
  await git(["-C", repositoryPath, "add", "README.md"]);
  await git(["-C", repositoryPath, "commit", "-qm", "initial"]);
  await git(["-C", repositoryPath, "branch", "-M", "main"]);
  return repositoryPath;
}

function targetIdFactory(bindingId: string, workspaceId: string): () => string {
  const ids = [bindingId, workspaceId];
  return () => ids.shift() ?? `${bindingId}-extra`;
}

async function catalogSnapshotFrom(
  worktree: IWorktreeService,
  observedAt: number,
  sessionSummary?: ProjectCatalogTargetSnapshot["sessionSummaries"][number],
  targetPresentation?: ProjectCatalogTargetSnapshot["targetPresentation"],
): Promise<ProjectCatalogTargetSnapshot> {
  const [availability, catalog] = await Promise.all([worktree.getAvailability(), worktree.read()]);
  return {
    schemaVersion: 1,
    targetId: availability.targetId,
    observedAt,
    ...(targetPresentation ? { targetPresentation } : {}),
    bindings: catalog.bindings.map((binding) => ({
      id: binding.id,
      projectId: binding.projectId,
      executionTargetId: binding.executionTargetId,
    })),
    workspaces: catalog.workspaces.map((workspace) => ({
      id: workspace.id,
      projectId: workspace.projectId,
      repositoryBindingId: workspace.repositoryBindingId,
      title: workspace.title,
      isMainWorktree: workspace.isMainWorktree,
      head: workspace.head,
      lifecycle: workspace.lifecycle,
      verification: workspace.verification,
    })),
    sessionSummaries: sessionSummary ? [sessionSummary] : [],
  };
}

const projectInput = {
  id: "project-one",
  name: "Project One",
  workspaceIds: ["legacy-main", "legacy-linked"],
  defaultWorkspaceId: "legacy-main",
  pinned: true,
  sortOrder: 4,
};

test("Project Catalog survives restart and keeps legacy defaults unscoped", async () => {
  await withCatalog(async (filePath) => {
    const first = createFileProjectCatalogService(filePath);
    const created = await first.createProject(projectInput);
    assert.equal(created.defaultWorkspaceId, "legacy-main");
    assert.deepEqual(created.workspaceIds, ["legacy-main", "legacy-linked"]);
    assert.ok(created.workspaceReferences.every((reference) => reference.targetId === null));

    const restarted = createFileProjectCatalogService(filePath);
    const snapshot = await restarted.read();
    assert.equal(snapshot.schemaVersion, 2);
    assert.deepEqual(snapshot.projects, [created]);

    await assert.rejects(
      restarted.setWorkspaceRefs("project-one", ["legacy-linked"], "legacy-main"),
      /default-workspace|workspace reference/i,
    );
    assert.deepEqual((await restarted.read()).projects[0], created);
  });
});

test("target snapshots merge by target and workspace while offline cache survives restart", async () => {
  await withRoot(async (root) => {
    const repositoryPath = await createRepository(root);
    const targetA = createFileWorktreeService({
      filePath: join(root, "target-a.json"),
      targetId: () => "target-a",
      idFactory: targetIdFactory("binding-a", "workspace-shared"),
    });
    const targetB = createFileWorktreeService({
      filePath: join(root, "target-b.json"),
      targetId: () => "target-b",
      idFactory: targetIdFactory("binding-b", "workspace-shared"),
    });
    const [discoveryA, discoveryB] = await Promise.all([
      targetA.discover(repositoryPath),
      targetB.discover(repositoryPath),
    ]);
    assert.equal(discoveryA.kind, "git");
    assert.equal(discoveryB.kind, "git");
    if (discoveryA.kind !== "git" || discoveryB.kind !== "git") return;
    const [adoptedA, adoptedB] = await Promise.all([
      targetA.adopt("project-one", discoveryA.candidates[0]!),
      targetB.adopt("project-one", discoveryB.candidates[0]!),
    ]);
    assert.equal(adoptedA.workspace.worktreePath, adoptedB.workspace.worktreePath);
    assert.equal(adoptedA.workspace.id, adoptedB.workspace.id);
    assert.notEqual(adoptedA.binding.id, adoptedB.binding.id);

    const catalogPath = join(root, "project-catalog.json");
    const catalogA = createFileProjectCatalogService(catalogPath);
    const catalogB = createFileProjectCatalogService(catalogPath);
    await catalogA.createProject({ id: "project-one", name: "Project One" });
    const firstA = await catalogSnapshotFrom(targetA, 1_800_000_000_001, undefined, {
      kind: "ssh",
      displayName: "SSH · build-lab",
    });
    await catalogA.ingestTargetSnapshot(firstA);
    await catalogA.setDefaultWorkspaceRef("project-one", {
      targetId: "target-a",
      workspaceId: adoptedA.workspace.id,
    });

    const runningSummary: ProjectCatalogTargetSnapshot["sessionSummaries"][number] = {
      workspaceId: adoptedB.workspace.id,
      sessions: [
        {
          sessionId: "session-running",
          workspaceId: adoptedB.workspace.id,
          harnessId: "pi",
          harnessName: "Pi",
          directoryStatus: "registered",
          icon: { kind: "fallback", fallback: "generic" },
          title: "Running task",
          activity: "running",
          freshness: "live",
          recentOutcome: "failed",
          unread: false,
          pendingInteractionCount: 1,
          updatedAt: 1_800_000_000_002,
          archived: false,
          kind: "top-level",
          attention: "pending",
        },
      ],
      summary: {
        sessionCount: 1,
        agentCount: 1,
        pendingInteractionCount: 1,
        runningCount: 1,
        errorCount: 1,
        unknownCount: 0,
        unreadCount: 0,
        attention: "pending",
      },
    };
    const [observedA, snapshotB] = await Promise.all([
      catalogSnapshotFrom(targetA, 1_800_000_000_003, undefined, {
        kind: "ssh",
        displayName: "SSH · build-lab",
      }),
      catalogSnapshotFrom(targetB, 1_800_000_000_002, runningSummary, {
        kind: "docker",
        displayName: "Docker · test-container",
      }),
    ]);
    const secondA: ProjectCatalogTargetSnapshot = {
      ...observedA,
      workspaces: observedA.workspaces.map((workspace) => ({
        ...workspace,
        title: "Fresh A presentation",
      })),
    };
    await Promise.all([
      catalogA.ingestTargetSnapshot(secondA),
      catalogB.ingestTargetSnapshot(snapshotB),
    ]);
    await catalogA.ingestTargetSnapshot(secondA);
    await assert.rejects(catalogA.ingestTargetSnapshot(firstA), /stale-target-snapshot/);
    await assert.rejects(
      catalogA.ingestTargetSnapshot({
        ...secondA,
        workspaces: secondA.workspaces.map((workspace) => ({
          ...workspace,
          title: "Conflicting same-time presentation",
        })),
      }),
      /conflicting-target-snapshot-at-same-observation/,
    );

    const merged = await catalogA.read();
    const project = merged.projects[0]!;
    assert.deepEqual(project.repositoryReferences.map((reference) => reference.targetId).sort(), [
      "target-a",
      "target-b",
    ]);
    const scopedWorkspaceReferences = project.workspaceReferences.filter(
      (reference) => reference.targetId !== null,
    );
    assert.deepEqual(scopedWorkspaceReferences.map((reference) => reference.targetId).sort(), [
      "target-a",
      "target-b",
    ]);
    assert.equal(
      scopedWorkspaceReferences[0]?.workspaceId,
      scopedWorkspaceReferences[1]?.workspaceId,
    );
    assert.equal(
      project.workspaceReferences.find((reference) => reference.targetId === "target-a")
        ?.presentation?.worktree.title,
      "Fresh A presentation",
    );
    assert.deepEqual(
      {
        targetId: project.defaultWorkspaceTargetId,
        workspaceId: project.defaultWorkspaceId,
      },
      { targetId: "target-a", workspaceId: adoptedA.workspace.id },
    );
    const partialRefresh: ProjectCatalogTargetSnapshot = {
      ...snapshotB,
      observedAt: 1_800_000_000_004,
      sessionSummaries: [],
    };
    await catalogA.ingestTargetSnapshot(partialRefresh);
    const summaryAfterPartialRefresh = (
      await catalogA.read()
    ).projects[0]?.workspaceReferences.find((reference) => reference.targetId === "target-b")
      ?.presentation?.sessionSummary;
    assert.equal(summaryAfterPartialRefresh?.verifiedAt, 1_800_000_000_002);
    assert.equal(summaryAfterPartialRefresh?.freshness, "stale");
    assert.equal(summaryAfterPartialRefresh?.sessions[0]?.activity, "running");
    assert.equal(summaryAfterPartialRefresh?.sessions[0]?.freshness, "stale");
    assert.equal(summaryAfterPartialRefresh?.sessions[0]?.pendingInteractionCount, 1);
    const legacyCompatibility = await catalogA.setWorkspaceRefs(
      "project-one",
      [adoptedA.workspace.id],
      adoptedA.workspace.id,
    );
    assert.equal(legacyCompatibility.defaultWorkspaceTargetId, "target-a");
    assert.equal(
      legacyCompatibility.workspaceReferences.filter((reference) => reference.targetId !== null)
        .length,
      2,
    );
    assert.equal(legacyCompatibility.workspaceReferences.at(-1)?.verification, "needsVerification");

    await catalogB.markTargetFreshness("target-b", "offline", 1_800_000_000_005);
    const worktreeOnlyAfterOffline: ProjectCatalogTargetSnapshot = {
      ...snapshotB,
      observedAt: 1_800_000_000_006,
      sessionSummaries: [],
    };
    await catalogA.ingestTargetSnapshot(worktreeOnlyAfterOffline);
    const afterReconnectWithoutSummary = (
      await catalogA.read()
    ).projects[0]?.workspaceReferences.find((reference) => reference.targetId === "target-b");
    assert.equal(afterReconnectWithoutSummary?.targetFreshness, "live");
    assert.equal(afterReconnectWithoutSummary?.presentation?.sessionSummary?.freshness, "stale");
    assert.equal(
      afterReconnectWithoutSummary?.presentation?.sessionSummary?.sessions[0]?.activity,
      "running",
    );
    assert.equal(
      afterReconnectWithoutSummary?.presentation?.sessionSummary?.sessions[0]
        ?.pendingInteractionCount,
      1,
    );
    const connectedAfterWorktreeOnly = await catalogA.readWorkspaceCatalog([
      { targetId: "target-b", state: "connected" },
    ]);
    const connectedSummary = connectedAfterWorktreeOnly.projects[0]?.workspaceReferences.find(
      (reference) => reference.targetId === "target-b",
    )?.presentation?.sessionSummary;
    assert.equal(connectedSummary?.freshness, "stale");
    assert.equal(connectedSummary?.sessions[0]?.freshness, "stale");
    assert.equal(connectedSummary?.sessions[0]?.activity, "running");
    await catalogB.markTargetFreshness("target-b", "offline", 1_800_000_000_007);
    const bytesBeforeFailedRefresh = await readFile(catalogPath, "utf8");
    await assert.rejects(
      catalogA.markTargetFreshness("target-b", "stale", 1_800_000_000_004),
      /stale-target-freshness-update/,
    );
    assert.equal(await readFile(catalogPath, "utf8"), bytesBeforeFailedRefresh);
    const { sessionSummaries: _knownSummaries, ...snapshotWithoutSummary } = snapshotB;
    await assert.rejects(
      catalogA.ingestTargetSnapshot({
        ...snapshotWithoutSummary,
        observedAt: 1_800_000_000_008,
      } as unknown as ProjectCatalogTargetSnapshot),
      /sessionSummaries|invalid/i,
    );
    assert.equal(await readFile(catalogPath, "utf8"), bytesBeforeFailedRefresh);
    await assert.rejects(
      catalogA.ingestTargetSnapshot({
        ...snapshotB,
        observedAt: 1_800_000_000_008,
        bindings: snapshotB.bindings.map((binding) => ({
          ...binding,
          projectId: "missing-project",
        })),
        workspaces: snapshotB.workspaces.map((workspace) => ({
          ...workspace,
          projectId: "missing-project",
        })),
      }),
      /unknown-project/,
    );
    assert.equal(await readFile(catalogPath, "utf8"), bytesBeforeFailedRefresh);

    const restarted = createFileProjectCatalogService(catalogPath);
    const offlineRead = await restarted.readWorkspaceCatalog([
      { targetId: "target-a", state: "connected" },
      { targetId: "target-b", state: "offline" },
    ]);
    assert.equal(offlineRead.schemaVersion, 1);
    assert.deepEqual(
      offlineRead.targets
        .map((target) => [target.targetId, target.presentation?.displayName])
        .sort(),
      [
        ["target-a", "SSH · build-lab"],
        ["target-b", "Docker · test-container"],
      ],
    );
    assert.equal(JSON.stringify(offlineRead).includes("remoteSessionId"), false);
    const persistedProject = offlineRead.projects[0]!;
    const offlineWorkspace = persistedProject.workspaceReferences.find(
      (reference) => reference.targetId === "target-b",
    )!;
    assert.equal(offlineWorkspace.targetFreshness, "offline");
    assert.equal(offlineWorkspace.presentation?.worktree.title, adoptedB.workspace.title);
    assert.equal(offlineWorkspace.presentation?.sessionSummary?.sessions[0]?.activity, "running");
    assert.equal(offlineWorkspace.presentation?.sessionSummary?.sessions[0]?.freshness, "offline");
    assert.equal(
      offlineWorkspace.presentation?.sessionSummary?.sessions[0]?.pendingInteractionCount,
      1,
    );
    assert.equal(
      offlineWorkspace.presentation?.sessionSummary?.sessions[0]?.recentOutcome,
      "failed",
    );
    assert.equal(offlineWorkspace.presentation?.sessionSummary?.summary.runningCount, 1);
    assert.equal(offlineWorkspace.presentation?.sessionSummary?.summary.errorCount, 1);
    assert.equal(
      persistedProject.workspaceReferences.find((reference) => reference.targetId === "target-a")
        ?.targetFreshness,
      "live",
    );
    const withoutCurrentConnections = await restarted.readWorkspaceCatalog();
    assert.equal(
      withoutCurrentConnections.projects[0]?.workspaceReferences.find(
        (reference) => reference.targetId === "target-a",
      )?.targetFreshness,
      "unknown",
    );
    assert.equal(JSON.stringify(offlineRead).includes(repositoryPath), false);
    assert.equal(
      JSON.stringify(offlineRead).includes(adoptedA.workspace.worktreeGeneration),
      false,
    );
  });
});

test("a Project can display a bare repository binding before its first workspace exists", async () => {
  await withRoot(async (root) => {
    const repositoryPath = await createRepository(root);
    const barePath = join(root, "catalog bare without worktrees.git");
    await git(["clone", "-q", "--bare", repositoryPath, barePath]);
    const worktree = createFileWorktreeService({
      filePath: join(root, "bare-target.json"),
      targetId: () => "target-bare-profile",
    });
    const discovery = await worktree.discover(barePath);
    assert.equal(discovery.kind, "bare");
    if (discovery.kind !== "bare") return;
    assert.deepEqual(discovery.candidates, []);
    const binding = await worktree.adoptBareRepository("project-bare", {
      targetId: discovery.targetId,
      inputPath: discovery.inputPath,
      repositoryCommonDir: discovery.repositoryCommonDir,
      commonDirEvidence: discovery.commonDirEvidence,
    });

    const catalog = createFileProjectCatalogService(join(root, "project-catalog.json"));
    const bindingOnlySnapshot = await catalogSnapshotFrom(worktree, 1_800_000_000_010);
    await assert.rejects(catalog.ingestTargetSnapshot(bindingOnlySnapshot), /unknown-project/);
    assert.equal((await worktree.read()).bindings.length, 1);
    assert.equal((await worktree.read()).workspaces.length, 0);
    await catalog.createProject({ id: "project-bare", name: "Bare Project" });
    await catalog.ingestTargetSnapshot(bindingOnlySnapshot);
    const bindingOnly = (await catalog.read()).projects[0]!;
    assert.equal(bindingOnly.repositoryReferences.length, 1);
    assert.equal(bindingOnly.repositoryReferences[0]?.repositoryBindingId, binding.id);
    assert.equal(bindingOnly.workspaceReferences.length, 0);
    assert.equal(bindingOnly.defaultWorkspaceId, undefined);

    const created = await worktree.createWorkspace({
      requestId: "create-after-profile-binding",
      repositoryBindingId: binding.id,
      projectId: "project-bare",
      worktreePath: join(root, "first linked checkout"),
      title: "First linked checkout",
      mode: "new-branch",
      baseRef: "main",
      newBranch: "first-linked",
    });
    assert.equal(created.status, "created");
    await catalog.ingestTargetSnapshot(await catalogSnapshotFrom(worktree, 1_800_000_000_011));
    const withWorkspace = (await catalog.read()).projects[0]!;
    assert.equal(withWorkspace.repositoryReferences[0]?.repositoryBindingId, binding.id);
    assert.equal(withWorkspace.workspaceReferences.length, 1);
    assert.equal(withWorkspace.defaultWorkspaceId, undefined);
  });
});

test("schema v1 migrates without guessing a target and only writes v2 on mutation", async () => {
  await withCatalog(async (filePath) => {
    const legacy = JSON.stringify({
      schemaVersion: 1,
      projects: [
        {
          schemaVersion: 1,
          id: "legacy-project",
          name: "Legacy Project",
          defaultWorkspaceId: "legacy-workspace",
          workspaceIds: ["legacy-workspace"],
          pinned: false,
          sortOrder: 0,
        },
      ],
    });
    await writeFile(filePath, legacy, "utf8");
    const service = createFileProjectCatalogService(filePath);
    const migrated = await service.read();
    assert.equal(migrated.schemaVersion, 2);
    assert.equal(migrated.projects[0]?.defaultWorkspaceTargetId, undefined);
    assert.deepEqual(migrated.projects[0]?.workspaceReferences[0], {
      projectId: "legacy-project",
      targetId: null,
      workspaceId: "legacy-workspace",
      repositoryBindingId: null,
      verification: "needsVerification",
      lastVerifiedAt: null,
      targetFreshness: "unknown",
      presentation: null,
    });
    assert.equal(await readFile(filePath, "utf8"), legacy);

    const aggregate = await service.readWorkspaceCatalog([
      { targetId: "connected-target", state: "connected" },
    ]);
    assert.equal(aggregate.projects[0]?.workspaceReferences[0]?.targetId, null);
    await service.ingestTargetSnapshot({
      schemaVersion: 1,
      targetId: "connected-target",
      observedAt: 1_800_000_000_020,
      bindings: [
        {
          id: "binding-connected",
          projectId: "legacy-project",
          executionTargetId: "connected-target",
        },
      ],
      workspaces: [
        {
          id: "legacy-workspace",
          projectId: "legacy-project",
          repositoryBindingId: "binding-connected",
          title: "Observed after migration",
          isMainWorktree: true,
          head: { kind: "branch", ref: "main", oid: "abc123" },
          lifecycle: "active",
          verification: "verified",
        },
      ],
      sessionSummaries: [],
    });
    const afterConnectedSnapshot = (await service.read()).projects[0]!;
    assert.equal(afterConnectedSnapshot.defaultWorkspaceTargetId, undefined);
    assert.ok(
      afterConnectedSnapshot.workspaceReferences.some(
        (reference) =>
          reference.targetId === null && reference.verification === "needsVerification",
      ),
    );
    assert.ok(
      afterConnectedSnapshot.workspaceReferences.some(
        (reference) =>
          reference.targetId === "connected-target" && reference.workspaceId === "legacy-workspace",
      ),
    );
    await service.updateProject("legacy-project", { name: "Migrated Project" });
    const written = JSON.parse(await readFile(filePath, "utf8")) as { schemaVersion: number };
    assert.equal(written.schemaVersion, 2);
  });
});

test("future or malformed files refuse reads and writes without replacing bytes", async () => {
  await withCatalog(async (filePath) => {
    const invalid = '{"schemaVersion":2,"projects":[';
    await writeFile(filePath, invalid, "utf8");
    const service = createFileProjectCatalogService(filePath);
    await assert.rejects(service.read(), /JSON|unexpected|invalid/i);
    await assert.rejects(service.createProject(projectInput));
    assert.equal(await readFile(filePath, "utf8"), invalid);
  });

  await withCatalog(async (filePath) => {
    const future = JSON.stringify({ schemaVersion: 99, projects: [], targets: [] });
    await writeFile(filePath, future, "utf8");
    const service = createFileProjectCatalogService(filePath);
    await assert.rejects(service.read(), /version|expected|invalid/i);
    await assert.rejects(service.createProject(projectInput));
    assert.equal(await readFile(filePath, "utf8"), future);
  });
});

test("invalid public inputs and duplicate aggregate target states are rejected", async () => {
  await withCatalog(async (filePath) => {
    const service = createFileProjectCatalogService(filePath);
    await assert.rejects(
      service.createProject({
        ...projectInput,
        workspaceIds: ["workspace-main", "workspace-main"],
      }),
      /duplicate|workspace/i,
    );
    await assert.rejects(
      service.createProject({ ...projectInput, defaultWorkspaceId: "missing-workspace" }),
      /default-workspace|workspace reference/i,
    );
    await service.createProject({ id: "clean-project", name: "Clean Project" });
    await assert.rejects(
      service.readWorkspaceCatalog([
        { targetId: "target-a", state: "connected" },
        { targetId: "target-a", state: "offline" },
      ]),
      /duplicate-target-connection/,
    );
    assert.equal(
      projectCatalogFileSchema.safeParse({ schemaVersion: 2, projects: [], targets: [] }).success,
      true,
    );
  });
});
