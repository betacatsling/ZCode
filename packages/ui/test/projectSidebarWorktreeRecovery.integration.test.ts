import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  createFileProjectCatalogRepository,
  createProjectCatalogService,
  type IProjectCatalogService,
  type ProjectCatalogPersistence,
} from "@zcode/services/project-catalog";
import {
  createFileWorktreePersistence,
  createFileWorktreeService,
  type IWorktreeService,
  type WorktreePersistence,
} from "@zcode/services/worktree";
import { addProjectAndAdopt, type PendingAdoption } from "../src/project-sidebar/mutations.js";
import {
  createWorkspace,
  recoverWorkspaceCreation,
} from "../src/project-sidebar/workspaceMutations.js";

const execFile = promisify(execFileCallback);
const projectId = "project-sidebar-recovery";
const targetId = "target-local";

async function git(cwd: string | undefined, args: readonly string[]): Promise<string> {
  const result = await execFile("git", cwd ? ["-C", cwd, ...args] : [...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout.trim();
}

async function ingestTargetSnapshot(
  catalog: IProjectCatalogService,
  worktree: IWorktreeService,
): Promise<void> {
  const worktrees = await worktree.read();
  await catalog.ingestTargetSnapshot({
    schemaVersion: 1,
    targetId,
    observedAt: Date.now(),
    bindings: worktrees.bindings.map(({ id, projectId: ownerProjectId, executionTargetId }) => ({
      id,
      projectId: ownerProjectId,
      executionTargetId,
    })),
    workspaces: worktrees.workspaces.map(
      ({
        id,
        projectId: ownerProjectId,
        repositoryBindingId,
        title,
        isMainWorktree,
        head,
        lifecycle,
        verification,
      }) => ({
        id,
        projectId: ownerProjectId,
        repositoryBindingId,
        title,
        isMainWorktree,
        head,
        lifecycle,
        verification,
      }),
    ),
    sessionSummaries: [],
  });
}

async function createHarness(root: string) {
  const mainPath = join(root, "repo with spaces");
  await git(undefined, ["init", "-q", "-b", "main", mainPath]);
  await git(mainPath, ["config", "user.email", "sidebar-test@example.com"]);
  await git(mainPath, ["config", "user.name", "Sidebar Recovery Test"]);
  await writeFile(join(mainPath, "README.md"), "initial\n", "utf8");
  await git(mainPath, ["add", "README.md"]);
  await git(mainPath, ["commit", "-qm", "initial"]);
  await git(mainPath, ["branch", "release-candidate"]);
  await git(mainPath, ["branch", "user-linked"]);

  let failNextWorktreeWrite = false;
  const fileWorktreePersistence = createFileWorktreePersistence(join(root, "worktrees.json"));
  const injectedWorktreePersistence: WorktreePersistence = {
    read: () => fileWorktreePersistence.read(),
    update: async (mutator) => {
      if (failNextWorktreeWrite) {
        failNextWorktreeWrite = false;
        throw new Error("injected-worktree-persistence-failure");
      }
      return fileWorktreePersistence.update(mutator);
    },
  };
  const realWorktree = createFileWorktreeService({
    filePath: join(root, "worktrees.json"),
    targetId: () => targetId,
    persistence: injectedWorktreePersistence,
    admissionRoot: join(root, "admission"),
  });
  const worktreeCalls = { creates: [] as string[], adoptions: [] as string[] };
  const worktree: IWorktreeService = {
    ...realWorktree,
    async createWorkspace(request) {
      worktreeCalls.creates.push(request.requestId);
      return realWorktree.createWorkspace(request);
    },
    async adopt(id, candidate, title) {
      worktreeCalls.adoptions.push(candidate.worktreePath);
      return realWorktree.adopt(id, candidate, title);
    },
  };

  const fileCatalogRepository = createFileProjectCatalogRepository(join(root, "projects.json"));
  let failNextCatalogWrite = false;
  let catalogWriteAttempts = 0;
  const persistence: ProjectCatalogPersistence = {
    read: () => fileCatalogRepository.read(),
    async update(mutator) {
      catalogWriteAttempts += 1;
      if (failNextCatalogWrite) {
        failNextCatalogWrite = false;
        throw new Error("injected-project-reference-persistence-failure");
      }
      return fileCatalogRepository.update(mutator);
    },
  };
  const catalog = createProjectCatalogService({ persistence });

  await catalog.createProject({ id: projectId, name: "Sidebar recovery" });
  const discovery = await realWorktree.discover(mainPath);
  assert.equal(discovery.kind, "git");
  if (discovery.kind !== "git") throw new Error("test repository discovery failed");
  const mainCandidate = discovery.candidates.find((candidate) => candidate.isMainWorktree);
  assert.ok(mainCandidate);
  const main = await realWorktree.adopt(projectId, mainCandidate, "Main checkout");
  await ingestTargetSnapshot(catalog, realWorktree);
  await catalog.setDefaultWorkspaceRef(projectId, {
    targetId,
    workspaceId: main.workspace.id,
  });

  return {
    mainPath,
    mainWorkspaceId: main.workspace.id,
    repositoryBindingId: main.binding.id,
    realWorktree,
    worktree,
    worktreeCalls,
    catalog,
    catalogWriteAttempts: () => catalogWriteAttempts,
    failWorktreeWrite() {
      failNextWorktreeWrite = true;
    },
    failCatalogWrite() {
      failNextCatalogWrite = true;
    },
  };
}

function request(bindingId: string, path: string, requestId: string) {
  return {
    requestId,
    repositoryBindingId: bindingId,
    projectId,
    worktreePath: path,
    title: "Recovery workspace",
    mode: "existing-branch" as const,
    existingBranch: "release-candidate",
  };
}

async function withRoot(run: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-project-sidebar-recovery-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("unregistered Git creation recovers through adopt without a second create", async () => {
  await withRoot(async (root) => {
    const harness = await createHarness(root);
    const worktreePath = join(root, "recovered-worktree");
    const requestIds = new Map<string, string>();
    const createRequest = request(
      harness.repositoryBindingId,
      worktreePath,
      "stable-workspace-request",
    );
    harness.failWorktreeWrite();

    const created = await createWorkspace({
      catalog: harness.catalog,
      worktree: harness.worktree,
      targetId,
      requestIds,
      request: createRequest,
      refresh: async () => undefined,
    });
    assert.equal(created.status, "unregistered");
    if (created.status !== "unregistered") throw new Error("expected an unregistered result");
    assert.equal(created.candidate.worktreePath, worktreePath);
    assert.match(created.error, /injected-worktree-persistence-failure/);
    const receiptsBeforeRecovery = (await harness.worktree.read()).creationReceipts;

    const discovered = await harness.realWorktree.discover(harness.mainPath);
    assert.equal(discovered.kind, "git");
    if (discovered.kind !== "git") throw new Error("recovery candidate discovery failed");
    const branchCandidate = discovered.candidates.find(
      (candidate) => candidate.worktreePath === worktreePath,
    );
    assert.equal(branchCandidate?.head.kind, "branch");
    if (branchCandidate?.head.kind !== "branch") throw new Error("created branch missing");
    assert.equal(branchCandidate.head.ref, "release-candidate");

    await recoverWorkspaceCreation({
      catalog: harness.catalog,
      worktree: harness.worktree,
      targetId,
      requestIds,
      request: createRequest,
      candidate: created.candidate,
      isCurrent: () => true,
      refresh: async () => undefined,
    });

    const file = await harness.worktree.read();
    const recovered = file.workspaces.filter(
      (workspace) => workspace.worktreePath === worktreePath,
    );
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]?.origin, "adopted");
    assert.equal(recovered[0]?.title, "Recovery workspace");
    assert.equal(recovered[0]?.head.kind, "branch");
    if (recovered[0]?.head.kind !== "branch") throw new Error("recovered branch missing");
    assert.equal(recovered[0].head.ref, "release-candidate");
    assert.equal(recovered[0].head.oid, branchCandidate.head.oid);
    assert.deepEqual(file.creationReceipts, receiptsBeforeRecovery);
    assert.deepEqual(harness.worktreeCalls.creates, ["stable-workspace-request"]);
    assert.deepEqual(harness.worktreeCalls.adoptions, [worktreePath]);

    const project = (await harness.catalog.read()).projects.find((item) => item.id === projectId);
    assert.ok(project);
    assert.ok(
      project.workspaceReferences.some((reference) => reference.workspaceId === recovered[0]!.id),
    );
    assert.equal(project.defaultWorkspaceId, harness.mainWorkspaceId);
    assert.equal(project.defaultWorkspaceTargetId, targetId);
  });
});

test("Catalog snapshot failure retries by idempotent adopt and preserves the scoped default", async () => {
  await withRoot(async (root) => {
    const harness = await createHarness(root);
    const worktreePath = join(root, "catalog-retry-worktree");
    const requestIds = new Map<string, string>();
    const createRequest = request(
      harness.repositoryBindingId,
      worktreePath,
      "catalog-retry-request",
    );
    const writesBefore = harness.catalogWriteAttempts();
    harness.failCatalogWrite();

    const created = await createWorkspace({
      catalog: harness.catalog,
      worktree: harness.worktree,
      targetId,
      requestIds,
      request: createRequest,
      refresh: async () => undefined,
    });
    assert.equal(created.status, "unregistered");
    if (created.status !== "unregistered") throw new Error("expected an unregistered result");
    assert.equal((await harness.worktree.read()).workspaces.length, 2);
    const referenceAfterFailure = (await harness.catalog.read()).projects[0]?.workspaceReferences;
    assert.equal(referenceAfterFailure?.length, 1);

    await recoverWorkspaceCreation({
      catalog: harness.catalog,
      worktree: harness.worktree,
      targetId,
      requestIds,
      request: createRequest,
      candidate: created.candidate,
      isCurrent: () => true,
      refresh: async () => undefined,
    });

    const file = await harness.worktree.read();
    const recovered = file.workspaces.filter(
      (workspace) => workspace.worktreePath === worktreePath,
    );
    assert.equal(recovered.length, 1);
    assert.equal(file.creationReceipts.length, 1);
    assert.deepEqual(harness.worktreeCalls.creates, ["catalog-retry-request"]);
    assert.deepEqual(harness.worktreeCalls.adoptions, [worktreePath]);
    assert.equal(harness.catalogWriteAttempts(), writesBefore + 2);

    const project = (await harness.catalog.read()).projects.find((item) => item.id === projectId);
    assert.ok(project);
    assert.equal(
      project.workspaceReferences.filter((reference) => reference.workspaceId === recovered[0]?.id)
        .length,
      1,
    );
    assert.equal(project.defaultWorkspaceId, harness.mainWorkspaceId);
    assert.equal(project.defaultWorkspaceTargetId, targetId);
  });
});

test("ordinary create refuses a pre-existing linked path while explicit adoption registers it", async () => {
  await withRoot(async (root) => {
    const harness = await createHarness(root);
    const userLinkedPath = join(root, "user-linked-worktree");
    await git(harness.mainPath, ["worktree", "add", "-q", userLinkedPath, "user-linked"]);
    const requestIds = new Map<string, string>();
    const createRequest = {
      ...request(harness.repositoryBindingId, userLinkedPath, "user-path-create-request"),
      existingBranch: "user-linked",
    };

    await assert.rejects(
      createWorkspace({
        catalog: harness.catalog,
        worktree: harness.worktree,
        targetId,
        requestIds,
        request: createRequest,
        refresh: async () => undefined,
      }),
      /workspace-path-already-registered-requires-adopt/,
    );

    const pendingRef: { current: PendingAdoption | null } = { current: null };
    const choices = await addProjectAndAdopt({
      catalog: harness.catalog,
      worktree: harness.worktree,
      targetId,
      pendingRef,
      name: "Sidebar recovery",
      worktreePath: userLinkedPath,
      existingProjectId: projectId,
      refresh: async () => undefined,
    });
    assert.equal(choices.status, "choices");
    if (choices.status !== "choices") throw new Error("expected explicit candidate choices");
    const selected = choices.candidates.find(
      (candidate) => candidate.worktreePath === userLinkedPath,
    );
    assert.ok(selected);

    const adopted = await addProjectAndAdopt({
      catalog: harness.catalog,
      worktree: harness.worktree,
      targetId,
      pendingRef,
      name: "Sidebar recovery",
      worktreePath: userLinkedPath,
      selection: { kind: "worktree", candidate: selected },
      existingProjectId: projectId,
      refresh: async () => undefined,
    });
    assert.equal(adopted.status, "complete");

    const file = await harness.worktree.read();
    assert.equal(
      file.workspaces.filter((workspace) => workspace.worktreePath === userLinkedPath).length,
      1,
    );
    const project = (await harness.catalog.read()).projects.find((item) => item.id === projectId);
    assert.ok(project);
    assert.ok(
      project.workspaceReferences.some(
        (reference) => reference.workspaceId !== harness.mainWorkspaceId,
      ),
    );
    assert.equal(project.defaultWorkspaceId, harness.mainWorkspaceId);
    assert.equal(project.defaultWorkspaceTargetId, targetId);
    assert.equal(harness.worktreeCalls.creates.length, 1);
    assert.deepEqual(harness.worktreeCalls.adoptions, [userLinkedPath]);
  });
});
