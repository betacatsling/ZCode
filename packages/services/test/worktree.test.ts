import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deriveExecutionSnapshot } from "@zcode/shared/agent-host";
import {
  createFileWorktreeService,
  createNodeWorkspaceAdmissionController,
  createWorktreeService,
  nodeWorktreeFilesystem,
  nodeWorktreeGitExec,
  createFileWorktreePersistence,
  type WorktreeFilesystemPort,
  type WorktreeGitExecPort,
} from "../src/worktree/index.js";
import { parsePorcelainZ } from "../src/worktree/domain/porcelain.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string | undefined, args: readonly string[]): Promise<string> {
  const result = await execFile("git", cwd ? ["-C", cwd, ...args] : [...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}

async function createRepository(
  root: string,
  name: string,
): Promise<{
  main: string;
  linked: string;
  detached: string;
  bare: string;
  bareLinked: string;
}> {
  const main = join(root, name);
  const linked = join(root, `${name} linked\nworktree`);
  const detached = join(root, `${name} detached`);
  const bare = join(root, `${name} bare`);
  const bareLinked = join(root, `${name} bare linked`);
  await git(undefined, ["init", "-q", main]);
  await git(main, ["config", "user.email", "test@example.com"]);
  await git(main, ["config", "user.name", "Worktree Test"]);
  await writeFile(join(main, "README.md"), "initial\n", "utf8");
  await git(main, ["add", "README.md"]);
  await git(main, ["commit", "-qm", "initial"]);
  await git(main, ["branch", "-M", "main"]);
  await git(main, ["worktree", "add", "-q", linked, "-b", "feature"]);
  await git(main, ["worktree", "add", "-q", "--detach", detached, "HEAD"]);
  await git(undefined, ["clone", "-q", "--bare", main, bare]);
  await git(bare, ["worktree", "add", "-q", bareLinked, "-b", "bare-feature"]);
  return { main, linked, detached, bare, bareLinked };
}

async function withWorktree<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "zcode-worktree-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const provenIdleActivity = {
  async readNative() {
    return { complete: true, state: "idle" as const };
  },
  async readExternal() {
    return { complete: true, state: "idle" as const };
  },
};

function createRemovalService(filePath: string, activity = provenIdleActivity) {
  return createFileWorktreeService({
    filePath,
    targetId: () => "target-local",
    activity,
  });
}

async function adoptLinkedWorkspace(
  service: ReturnType<typeof createRemovalService>,
  linkedPath: string,
): Promise<{ id: string; generation: string }> {
  const discovery = await service.discover(linkedPath);
  assert.equal(discovery.kind, "git");
  if (discovery.kind !== "git") throw new Error("linked worktree discovery failed");
  const candidate = discovery.candidates.find((item) => item.worktreePath === linkedPath);
  assert.ok(candidate);
  const adopted = await service.adopt("project-one", candidate);
  return { id: adopted.workspace.id, generation: adopted.workspace.worktreeGeneration };
}

const passthroughFilesystem: WorktreeFilesystemPort = {
  async realpath(path) {
    return path;
  },
  async identity(path) {
    return { canonicalPath: path, device: 1, inode: 1, birthtimeMs: 1 };
  },
};

test("discover identifies main, linked, detached, spaces/newlines, and the common repository", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "repo with spaces \n");
    const service = createFileWorktreeService({
      filePath: join(root, "catalog.json"),
      targetId: () => "target-local",
    });
    assert.deepEqual(await service.getAvailability(), {
      targetId: "target-local",
      available: true,
      writable: true,
    });
    const result = await service.discover(fixture.linked);
    assert.equal(result.kind, "git");
    if (result.kind !== "git") return;
    assert.equal(result.candidates.length, 3);
    assert.equal(
      new Set(result.candidates.map((candidate) => candidate.repositoryCommonDir)).size,
      1,
    );
    assert.equal(
      result.candidates.some((candidate) => candidate.worktreePath === fixture.linked),
      true,
    );
    assert.equal(
      result.candidates.some(
        (candidate) => candidate.isMainWorktree && candidate.worktreePath === fixture.main,
      ),
      true,
    );
    assert.equal(
      result.candidates.some((candidate) => candidate.head.kind === "detached"),
      true,
    );
    assert.equal(result.targetId, "target-local");
    const adopted = await service.adopt(
      "project-one",
      result.candidates.find((candidate) => candidate.isMainWorktree)!,
    );
    const { commonDirEvidence: _commonDirEvidence, ...binding } = adopted.binding;
    const { filesystemEvidence: _filesystemEvidence, ...workspace } = adopted.workspace;
    const derived = deriveExecutionSnapshot({
      project: { schemaVersion: 1, id: "project-one", name: "Project One" },
      binding,
      workspace,
      session: {
        schemaVersion: 1,
        id: "session-one",
        workspaceId: workspace.id,
        harnessId: "mock",
        title: "Path check",
      },
    });
    assert.equal(derived.execution.worktreePath, fixture.main);
    assert.equal(derived.execution.workspaceIdentity, fixture.main);
    assert.equal(derived.execution.cwdRelativeToWorktree, ".");
    const child = join(fixture.main, "nested", "source");
    await mkdir(child, { recursive: true });
    const childResult = await service.discover(child);
    assert.equal(childResult.kind, "git");
    if (childResult.kind === "git") {
      assert.equal(childResult.repositoryCommonDir, result.repositoryCommonDir);
      assert.equal(childResult.candidates.length, result.candidates.length);
    }
  });
});

test("non-Git and bare paths are explicit discovery results without implicit git init", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "repo");
    const nonGit = join(root, "plain folder");
    await mkdir(nonGit);
    const service = createFileWorktreeService({
      filePath: join(root, "catalog.json"),
      targetId: () => "target-local",
    });
    const plain = await service.discover(nonGit);
    assert.equal(plain.kind, "nonGit");
    assert.equal(await readFile(join(nonGit, ".git"), "utf8").catch(() => null), null);
    const bare = await service.discover(fixture.bare);
    assert.equal(bare.kind, "bare");
    if (bare.kind === "bare") {
      assert.equal(bare.candidates.length, 1);
      assert.equal(bare.candidates[0]?.worktreePath, fixture.bareLinked);
      assert.equal(bare.candidates[0]?.isMainWorktree, false);
    }
  });
});

test("bare repository adoption registers only a binding and later shares it with one linked worktree", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "bare takeover");
    const barePath = join(root, "bare takeover without worktrees.git");
    await git(undefined, ["clone", "-q", "--bare", fixture.main, barePath]);
    const filePath = join(root, "bare-takeover-catalog.json");
    const service = createFileWorktreeService({ filePath, targetId: () => "target-bare" });
    const discovery = await service.discover(barePath);
    assert.equal(discovery.kind, "bare");
    if (discovery.kind !== "bare") return;
    assert.deepEqual(discovery.candidates, []);
    const request = {
      targetId: discovery.targetId,
      inputPath: discovery.inputPath,
      repositoryCommonDir: discovery.repositoryCommonDir,
      commonDirEvidence: discovery.commonDirEvidence,
    };

    const binding = await service.adoptBareRepository("project-bare", request);
    const repeated = await service.adoptBareRepository("project-bare", request);
    assert.equal(repeated.id, binding.id);
    const afterAdoption = await service.read();
    assert.equal(afterAdoption.bindings.length, 1);
    assert.equal(afterAdoption.workspaces.length, 0);
    assert.equal(afterAdoption.bindings[0]?.projectId, "project-bare");
    await assert.rejects(
      service.adoptBareRepository("another-project", request),
      /binding-project-mismatch/,
    );

    const created = await service.createWorkspace({
      requestId: "create-from-bare-binding",
      repositoryBindingId: binding.id,
      projectId: "project-bare",
      worktreePath: join(root, "created from bare"),
      title: "Created from bare",
      mode: "new-branch",
      baseRef: "main",
      newBranch: "catalog-created",
    });
    assert.equal(created.status, "created");
    if (created.status === "unregistered") return;
    assert.equal(created.binding.id, binding.id);
    assert.equal(created.workspace.isMainWorktree, false);
    const linkedDiscovery = await service.discover(created.workspace.worktreePath);
    assert.equal(linkedDiscovery.kind, "git");
    if (linkedDiscovery.kind !== "git") return;
    const adoptedLinked = await service.adopt(
      "project-bare",
      linkedDiscovery.candidates.find(
        (candidate) => candidate.worktreePath === created.workspace.worktreePath,
      )!,
    );
    assert.equal(adoptedLinked.binding.id, binding.id);
    assert.equal(adoptedLinked.workspace.id, created.workspace.id);
    const afterLinkedAdoption = await service.read();
    assert.equal(afterLinkedAdoption.bindings.length, 1);
    assert.equal(afterLinkedAdoption.workspaces.length, 1);

    const secondTarget = createFileWorktreeService({
      filePath: join(root, "other-target-catalog.json"),
      targetId: () => "target-other",
    });
    const otherDiscovery = await secondTarget.discover(barePath);
    assert.equal(otherDiscovery.kind, "bare");
    if (otherDiscovery.kind !== "bare") return;
    const otherBinding = await secondTarget.adoptBareRepository("project-bare", {
      targetId: otherDiscovery.targetId,
      inputPath: otherDiscovery.inputPath,
      repositoryCommonDir: otherDiscovery.repositoryCommonDir,
      commonDirEvidence: otherDiscovery.commonDirEvidence,
    });
    assert.notEqual(otherBinding.id, binding.id);
    assert.equal(otherBinding.executionTargetId, "target-other");
  });
});

test("bare adoption rejects stale evidence and empty bare repositories reject missing bases", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "bare replacement");
    const barePath = join(root, "replaceable bare.git");
    await git(undefined, ["clone", "-q", "--bare", fixture.main, barePath]);
    const service = createFileWorktreeService({
      filePath: join(root, "replacement-catalog.json"),
      targetId: () => "target-replacement",
    });
    const initial = await service.discover(barePath);
    assert.equal(initial.kind, "bare");
    if (initial.kind !== "bare") return;
    const staleRequest = {
      targetId: initial.targetId,
      inputPath: initial.inputPath,
      repositoryCommonDir: initial.repositoryCommonDir,
      commonDirEvidence: initial.commonDirEvidence,
    };
    await assert.rejects(
      service.adoptBareRepository("project-replacement", {
        ...staleRequest,
        commonDirEvidence: {
          ...staleRequest.commonDirEvidence,
          inode: (staleRequest.commonDirEvidence.inode ?? 0) + 1,
        },
      }),
      /stale-bare-repository-evidence/,
    );

    const replacementPath = `${barePath}.replacement`;
    await rename(barePath, replacementPath);
    await git(undefined, ["clone", "-q", "--bare", fixture.main, barePath]);
    const replacement = await service.discover(barePath);
    assert.equal(replacement.kind, "bare");
    if (replacement.kind !== "bare") return;
    assert.notDeepEqual(replacement.commonDirEvidence, staleRequest.commonDirEvidence);
    await assert.rejects(
      service.adoptBareRepository("project-replacement", staleRequest),
      /stale-bare-repository-evidence/,
    );
    assert.equal((await service.read()).bindings.length, 0);

    const emptyBarePath = join(root, "empty bare.git");
    await git(undefined, ["init", "-q", "--bare", emptyBarePath]);
    const emptyService = createFileWorktreeService({
      filePath: join(root, "empty-catalog.json"),
      targetId: () => "target-empty",
    });
    const emptyDiscovery = await emptyService.discover(emptyBarePath);
    assert.equal(emptyDiscovery.kind, "bare");
    if (emptyDiscovery.kind !== "bare") return;
    assert.deepEqual(emptyDiscovery.candidates, []);
    const emptyBinding = await emptyService.adoptBareRepository("project-empty", {
      targetId: emptyDiscovery.targetId,
      inputPath: emptyDiscovery.inputPath,
      repositoryCommonDir: emptyDiscovery.repositoryCommonDir,
      commonDirEvidence: emptyDiscovery.commonDirEvidence,
    });
    assert.equal((await emptyService.read()).workspaces.length, 0);
    await assert.rejects(
      emptyService.createWorkspace({
        requestId: "empty-bare-invalid-base",
        repositoryBindingId: emptyBinding.id,
        projectId: "project-empty",
        worktreePath: join(root, "must not exist"),
        title: "No base",
        mode: "new-branch",
        baseRef: "missing-base",
        newBranch: "cannot-create",
      }),
      /invalid-base-ref/,
    );
    await assert.rejects(readFile(join(root, "must not exist")), { code: "ENOENT" });
    assert.equal((await emptyService.read()).workspaces.length, 0);
  });
});

test("explicit adoption shares a binding for same target/common directory and is idempotent", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "repo");
    const filePath = join(root, "catalog.json");
    const service = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    const discovered = await service.discover(fixture.main);
    assert.equal(discovered.kind, "git");
    if (discovered.kind !== "git") return;
    const mainCandidate = discovered.candidates.find(
      (candidate) => candidate.worktreePath === fixture.main,
    )!;
    const linkedCandidate = discovered.candidates.find(
      (candidate) => candidate.worktreePath === fixture.linked,
    )!;
    await assert.rejects(
      service.adopt("project-one", {
        ...mainCandidate,
        filesystemEvidence: {
          ...mainCandidate.filesystemEvidence,
          birthtimeMs: mainCandidate.filesystemEvidence.birthtimeMs! + 1,
        },
      }),
      /stale|candidate|verification/i,
    );
    const main = await service.adopt("project-one", mainCandidate);
    const linked = await service.adopt("project-one", linkedCandidate);
    const repeated = await service.adopt("project-one", linkedCandidate);
    const snapshot = await service.read();
    assert.equal(snapshot.bindings.length, 1);
    assert.equal(snapshot.workspaces.length, 2);
    assert.equal(main.binding.id, linked.binding.id);
    assert.equal(repeated.workspace.id, linked.workspace.id);
    assert.equal(snapshot.workspaces[0]?.verification, "verified");

    const reopened = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    assert.equal((await reopened.read()).workspaces.length, 2);
  });
});

test("same path on separate targets is isolated and origin is never used for merging", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "same-path");
    const first = createFileWorktreeService({
      filePath: join(root, "target-a.json"),
      targetId: () => "target-a",
    });
    const second = createFileWorktreeService({
      filePath: join(root, "target-b.json"),
      targetId: () => "target-b",
    });
    const firstResult = await first.discover(fixture.main);
    const secondResult = await second.discover(fixture.main);
    assert.equal(firstResult.kind, "git");
    assert.equal(secondResult.kind, "git");
    if (firstResult.kind !== "git" || secondResult.kind !== "git") return;
    const firstAdopted = await first.adopt("project-one", firstResult.candidates[0]!);
    const secondAdopted = await second.adopt("project-two", secondResult.candidates[0]!);
    assert.notEqual(firstAdopted.binding.id, secondAdopted.binding.id);
    assert.equal(firstAdopted.binding.executionTargetId, "target-a");
    assert.equal(secondAdopted.binding.executionTargetId, "target-b");
  });
});

test("revalidation marks missing/rebuilt paths and only explicit acceptance advances generation", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "rebuild");
    const filePath = join(root, "catalog.json");
    const service = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    const discovery = await service.discover(fixture.main);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    const adopted = await service.adopt(
      "project-one",
      discovery.candidates.find((candidate) => candidate.isMainWorktree)!,
    );
    const generation = adopted.workspace.worktreeGeneration;
    const oldHead = adopted.workspace.head;
    await writeFile(join(fixture.main, "README.md"), "changed\n", "utf8");
    await git(fixture.main, ["add", "README.md"]);
    await git(fixture.main, ["commit", "-qm", "changed"]);
    await git(fixture.main, ["branch", "-M", "renamed"]);
    const changed = await service.revalidate(adopted.workspace.id);
    assert.equal(changed.status, "verified");
    assert.equal(changed.workspace.worktreeGeneration, generation);
    assert.equal(changed.workspace.head.kind, "branch");
    if (changed.workspace.head.kind === "branch" && oldHead.kind === "branch") {
      assert.equal(changed.workspace.head.ref, "renamed");
      assert.notEqual(changed.workspace.head.oid, oldHead.oid);
    }
    await rm(fixture.main, { recursive: true, force: true });
    const missing = await service.revalidate(adopted.workspace.id);
    assert.equal(missing.status, "missing");
    assert.equal(missing.workspace.verification, "needsVerification");
    await git(undefined, ["init", "-q", fixture.main]);
    await git(fixture.main, ["config", "user.email", "test@example.com"]);
    await git(fixture.main, ["config", "user.name", "Worktree Test"]);
    await writeFile(join(fixture.main, "new"), "recreated\n", "utf8");
    await git(fixture.main, ["add", "new"]);
    await git(fixture.main, ["commit", "-qm", "recreated"]);
    const needsVerification = await service.revalidate(adopted.workspace.id);
    assert.equal(needsVerification.status, "needsVerification");
    assert.equal(needsVerification.workspace.worktreeGeneration, generation);
    const accepted = await service.revalidate(adopted.workspace.id, { acceptRebuild: true });
    assert.equal(accepted.status, "verified");
    assert.notEqual(accepted.workspace.worktreeGeneration, generation);
  });
});

test("revalidation preserves archived and removed lifecycle values", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "lifecycle");
    const filePath = join(root, "catalog.json");
    const service = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    const discovery = await service.discover(fixture.main);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    const adopted = await service.adopt("project-one", discovery.candidates[0]!);
    for (const lifecycle of ["archived", "removed"] as const) {
      const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
        workspaces: Array<Record<string, unknown>>;
      };
      persisted.workspaces[0]!.lifecycle = lifecycle;
      await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
      const result = await service.revalidate(adopted.workspace.id);
      assert.equal(result.workspace.lifecycle, lifecycle);
    }
  });
});

test("failed discovery never clears an existing persisted catalog", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "failure");
    const filePath = join(root, "catalog.json");
    const healthy = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    const discovery = await healthy.discover(fixture.main);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    await healthy.adopt("project-one", discovery.candidates[0]!);
    const before = await readFile(filePath, "utf8");
    const failingGit: WorktreeGitExecPort = {
      async run() {
        return { stdout: "", stderr: "synthetic failure", exitCode: 1 };
      },
    };
    const failing = createFileWorktreeService({
      filePath,
      targetId: () => "target-local",
      git: failingGit,
      filesystem: passthroughFilesystem,
    });
    await assert.rejects(failing.discover(fixture.main), /synthetic|git/i);
    await assert.rejects(
      failing.revalidate((await healthy.read()).workspaces[0]!.id),
      /synthetic|git/i,
    );
    assert.equal(await readFile(filePath, "utf8"), before);
  });
});

test("missing revalidation rejects a stale observation after another owner updates generation", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "race");
    const filePath = join(root, "catalog.json");
    const healthy = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    const discovery = await healthy.discover(fixture.main);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    const adopted = await healthy.adopt("project-one", discovery.candidates[0]!);
    let injected = false;
    const racingFilesystem: WorktreeFilesystemPort = {
      realpath: nodeWorktreeFilesystem.realpath,
      async identity(path) {
        if (!injected) {
          injected = true;
          const persisted = JSON.parse(await readFile(filePath, "utf8")) as {
            workspaces: Array<Record<string, unknown>>;
          };
          persisted.workspaces[0]!.worktreeGeneration = "raced-generation";
          await writeFile(filePath, `${JSON.stringify(persisted, null, 2)}\n`, "utf8");
          throw Object.assign(new Error("synthetic missing path"), { code: "ENOENT" });
        }
        return nodeWorktreeFilesystem.identity(path);
      },
    };
    const racing = createFileWorktreeService({
      filePath,
      targetId: () => "target-local",
      filesystem: racingFilesystem,
    });
    await assert.rejects(racing.revalidate(adopted.workspace.id), /stale-worktree-observation/);
    const after = JSON.parse(await readFile(filePath, "utf8")) as {
      workspaces: Array<Record<string, unknown>>;
    };
    assert.equal(after.workspaces[0]?.worktreeGeneration, "raced-generation");
  });
});

test("bad and future persistence schemas refuse reads without replacing bytes", async () => {
  await withWorktree(async (root) => {
    const filePath = join(root, "catalog.json");
    const future = JSON.stringify({ schemaVersion: 99, bindings: [], workspaces: [] });
    await writeFile(filePath, future, "utf8");
    const service = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    await assert.rejects(service.read(), /version|expected|invalid/i);
    assert.equal(await readFile(filePath, "utf8"), future);
  });
});

test("NUL porcelain parsing preserves paths with spaces and newlines", () => {
  const result = parsePorcelainZ(
    [
      `worktree /tmp/with space\ninside\0HEAD ${"a".repeat(40)}\0branch refs/heads/main\0\0`,
      `worktree /tmp/linked path\0HEAD ${"b".repeat(40)}\0detached\0\0`,
    ].join(""),
  );
  assert.equal(result[0]?.path, "/tmp/with space\ninside");
  assert.equal(result[1]?.head.kind, "detached");
});

test("createWorkspace adds new and existing branches, including a bare linked repository", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "create repo");
    await git(fixture.main, ["branch", "existing"]).then(() => undefined);
    const filePath = join(root, "catalog.json");
    const service = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    const discovered = await service.discover(fixture.main);
    assert.equal(discovered.kind, "git");
    if (discovered.kind !== "git") return;
    const binding = (await service.adopt("project-one", discovered.candidates[0]!)).binding;
    const created = await service.createWorkspace({
      requestId: "create-new",
      repositoryBindingId: binding.id,
      projectId: "project-one",
      worktreePath: join(root, "new branch\nworktree"),
      title: "New branch",
      mode: "new-branch",
      baseRef: "main",
      newBranch: "created/feature",
    });
    assert.equal(created.status, "created");
    if (created.status === "unregistered") return;
    assert.equal(created.workspace.origin, "created");
    assert.equal(created.workspace.head.kind, "branch");
    if (created.workspace.head.kind === "branch")
      assert.equal(created.workspace.head.ref, "created/feature");
    assert.equal(
      await readFile(join(created.workspace.worktreePath, "README.md"), "utf8"),
      "initial\n",
    );

    const existing = await service.createWorkspace({
      requestId: "create-existing",
      repositoryBindingId: binding.id,
      projectId: "project-one",
      worktreePath: join(root, "existing branch worktree"),
      title: "Existing branch",
      mode: "existing-branch",
      existingBranch: "existing",
    });
    assert.equal(existing.status, "created");
    const bareService = createFileWorktreeService({
      filePath: join(root, "bare-catalog.json"),
      targetId: () => "target-bare",
    });
    const bareDiscovery = await bareService.discover(fixture.bare);
    assert.equal(bareDiscovery.kind, "bare");
    if (bareDiscovery.kind !== "bare") return;
    const bareBinding = (await bareService.adopt("project-bare", bareDiscovery.candidates[0]!))
      .binding;
    const bareCreated = await bareService.createWorkspace({
      requestId: "create-bare",
      repositoryBindingId: bareBinding.id,
      projectId: "project-bare",
      worktreePath: join(root, "bare-created"),
      title: "Bare linked",
      mode: "new-branch",
      baseRef: "main",
      newBranch: "bare-created",
    });
    assert.equal(bareCreated.status, "created");
  });
});

test("createWorkspace rejects invalid refs, occupied paths, and checked-out branches", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "create rejects");
    const service = createFileWorktreeService({
      filePath: join(root, "catalog.json"),
      targetId: () => "target-local",
    });
    const discovery = await service.discover(fixture.main);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    const binding = (
      await service.adopt(
        "project-one",
        discovery.candidates.find((candidate) => !candidate.isMainWorktree)!,
      )
    ).binding;
    await assert.rejects(
      service.createWorkspace({
        requestId: "adopted-path",
        repositoryBindingId: binding.id,
        projectId: "project-one",
        worktreePath: fixture.linked,
        title: "Existing linked",
        mode: "existing-branch",
        existingBranch: "feature",
      }),
      /registered|adopt/i,
    );
    await assert.rejects(
      service.createWorkspace({
        requestId: "main-path",
        repositoryBindingId: binding.id,
        projectId: "project-one",
        worktreePath: fixture.main,
        title: "Main path",
        mode: "existing-branch",
        existingBranch: "main",
      }),
      /main.?worktree|linkable/i,
    );
    await assert.rejects(
      service.createWorkspace({
        requestId: "invalid-ref",
        repositoryBindingId: binding.id,
        projectId: "project-one",
        worktreePath: join(root, "invalid"),
        title: "Invalid",
        mode: "new-branch",
        baseRef: "main",
        newBranch: "bad..branch",
      }),
      /ref|branch/i,
    );
    const occupied = join(root, "occupied");
    await mkdir(occupied);
    await assert.rejects(
      service.createWorkspace({
        requestId: "occupied",
        repositoryBindingId: binding.id,
        projectId: "project-one",
        worktreePath: occupied,
        title: "Occupied",
        mode: "new-branch",
        baseRef: "main",
        newBranch: "occupied-branch",
      }),
      /occupied/i,
    );
    await assert.rejects(
      service.createWorkspace({
        requestId: "checked-out",
        repositoryBindingId: binding.id,
        projectId: "project-one",
        worktreePath: join(root, "checked-out-again"),
        title: "Checked out",
        mode: "existing-branch",
        existingBranch: "feature",
      }),
      /checked.?out/i,
    );
  });
});

test("concurrent createWorkspace calls register one candidate and retries are idempotent", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "create race");
    const filePath = join(root, "catalog.json");
    const first = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    const discovery = await first.discover(fixture.main);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    const binding = (await first.adopt("project-one", discovery.candidates[0]!)).binding;
    const second = createFileWorktreeService({ filePath, targetId: () => "target-local" });
    const request = {
      requestId: "same-request",
      repositoryBindingId: binding.id,
      projectId: "project-one",
      worktreePath: join(root, "concurrent"),
      title: "Concurrent",
      mode: "new-branch" as const,
      baseRef: "main",
      newBranch: "concurrent-branch",
    };
    const results = await Promise.all([
      first.createWorkspace(request),
      second.createWorkspace(request),
    ]);
    assert.deepEqual(
      new Set(results.map((result) => result.status)),
      new Set(["created", "already-present"]),
    );
    assert.equal((await first.read()).workspaces.length, 2);
    const retry = await second.createWorkspace(request);
    assert.equal(retry.status, "already-present");
    assert.equal((await second.read()).workspaces.length, 2);
    await assert.rejects(
      second.createWorkspace({ ...request, title: "Changed after receipt" }),
      /request-id-reused/i,
    );
  });
});

test("Git success with catalog failure returns an unregistered candidate without cleanup", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "create partial");
    const healthyPath = join(root, "healthy.json");
    const healthy = createFileWorktreeService({
      filePath: healthyPath,
      targetId: () => "target-local",
    });
    const discovery = await healthy.discover(fixture.main);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    const binding = (await healthy.adopt("project-one", discovery.candidates[0]!)).binding;
    const raw = await readFile(healthyPath, "utf8");
    const failing = createWorktreeService({
      targetId: () => "target-local",
      git: nodeWorktreeGitExec,
      filesystem: nodeWorktreeFilesystem,
      operationLock: (task) => task(),
      prepareHooksPath: async () => {
        const hooksPath = join(root, "partial-hooks");
        await mkdir(hooksPath, { recursive: true });
        return hooksPath;
      },
      persistence: {
        async read() {
          return JSON.parse(raw) as unknown;
        },
        async update() {
          throw new Error("catalog-write-failed");
        },
      },
    });
    const result = await failing.createWorkspace({
      requestId: "partial",
      repositoryBindingId: binding.id,
      projectId: "project-one",
      worktreePath: join(root, "partial-created"),
      title: "Partial",
      mode: "new-branch",
      baseRef: "main",
      newBranch: "partial-branch",
    });
    assert.equal(result.status, "unregistered");
    assert.ok(result.candidate);
    assert.equal(await readFile(join(root, "partial-created", "README.md"), "utf8"), "initial\n");
    assert.match(
      await git(fixture.main, ["show-ref", "--verify", "refs/heads/partial-branch"]),
      /partial-branch/,
    );
    const recoveredDiscovery = await healthy.discover(join(root, "partial-created"));
    assert.equal(recoveredDiscovery.kind, "git");
    if (recoveredDiscovery.kind !== "git") return;
    const recoveredCandidate = recoveredDiscovery.candidates.find(
      (candidate) => candidate.worktreePath === join(root, "partial-created"),
    );
    assert.ok(recoveredCandidate);
    const recovered = await healthy.adopt("project-one", recoveredCandidate!, "Partial");
    assert.equal(recovered.workspace.origin, "adopted");
    assert.equal((await healthy.read()).workspaces.length, 2);
  });
});

test("workspace rename and archive metadata never touch user files", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "metadata");
    const service = createFileWorktreeService({
      filePath: join(root, "catalog.json"),
      targetId: () => "target-local",
    });
    const discovery = await service.discover(fixture.main);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    const binding = (await service.adopt("project-one", discovery.candidates[0]!)).binding;
    const created = await service.createWorkspace({
      requestId: "metadata-workspace",
      repositoryBindingId: binding.id,
      projectId: "project-one",
      worktreePath: join(root, "metadata-created"),
      title: "Original",
      mode: "new-branch",
      baseRef: "main",
      newBranch: "metadata-branch",
    });
    assert.equal(created.status, "created");
    if (created.status === "unregistered") return;
    const readme = await readFile(join(created.workspace.worktreePath, "README.md"), "utf8");
    const renamed = await service.updateWorkspace({
      operation: "rename",
      workspaceId: created.workspace.id,
      title: "Renamed",
    });
    assert.equal(renamed.title, "Renamed");
    const archived = await service.updateWorkspace({
      operation: "archive",
      workspaceId: created.workspace.id,
    });
    assert.equal(archived.lifecycle, "archived");
    const unarchived = await service.updateWorkspace({
      operation: "unarchive",
      workspaceId: created.workspace.id,
    });
    assert.equal(unarchived.lifecycle, "active");
    assert.equal(await readFile(join(created.workspace.worktreePath, "README.md"), "utf8"), readme);
  });
});

test("confirmed removal removes only a clean linked worktree and preserves its branch and history identity", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "remove clean");
    const service = createRemovalService(join(root, "catalog.json"));
    const linked = await adoptLinkedWorkspace(service, fixture.linked);
    const preview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.equal(preview.safeToRemove, true);
    assert.ok(preview.confirmationToken);
    assert.equal(preview.externalProcessBoundary, "unmanaged-writers-not-enumerated");

    const removed = await service.removeWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
      confirmationToken: preview.confirmationToken!,
    });
    assert.equal(removed.lifecycle, "removed");
    await assert.rejects(readFile(fixture.linked));
    assert.equal(
      await git(fixture.main, ["show-ref", "--verify", "refs/heads/feature"]).then(() => true),
      true,
    );
    assert.equal(
      (await service.read()).workspaces.find((item) => item.id === linked.id)?.id,
      linked.id,
    );
    assert.equal(await readFile(join(fixture.main, "README.md"), "utf8"), "initial\n");
  });
});

test("removal preview rejects main, dirty, untracked, locked, and submodule worktrees", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "remove unsafe");
    const service = createRemovalService(join(root, "catalog.json"));
    const discovery = await service.discover(fixture.main);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    const mainCandidate = discovery.candidates.find((item) => item.isMainWorktree)!;
    const main = await service.adopt("project-one", mainCandidate);
    const mainPreview = await service.previewRemoveWorkspace({
      workspaceId: main.workspace.id,
      expectedGeneration: main.workspace.worktreeGeneration,
    });
    assert.ok(mainPreview.blockers.includes("main-worktree"));

    const linked = await adoptLinkedWorkspace(service, fixture.linked);
    await writeFile(join(fixture.linked, "README.md"), "dirty\n", "utf8");
    let preview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.ok(preview.blockers.includes("dirty"));
    await git(fixture.linked, ["checkout", "--", "README.md"]);

    await writeFile(join(fixture.linked, "untracked.txt"), "keep me\n", "utf8");
    preview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.ok(preview.blockers.includes("untracked"));
    await rm(join(fixture.linked, "untracked.txt"));

    const ignoreFile = join(root, "worktree-ignore");
    await writeFile(ignoreFile, "ignored.txt\n", "utf8");
    await git(fixture.main, ["config", "core.excludesFile", ignoreFile]);
    await writeFile(join(fixture.linked, "ignored.txt"), "preserve me\n", "utf8");
    preview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.ok(preview.blockers.includes("untracked"));
    await rm(join(fixture.linked, "ignored.txt"));

    const oid = (await git(fixture.linked, ["rev-parse", "HEAD"])).trim();
    await git(fixture.linked, ["update-index", "--add", "--cacheinfo", `160000,${oid},submodule`]);
    preview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.ok(preview.blockers.includes("submodule"));
    await git(fixture.linked, ["update-index", "--force-remove", "submodule"]);

    await git(fixture.main, ["worktree", "lock", "--reason", "test lock", fixture.linked]);
    preview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.ok(preview.blockers.includes("locked"));
  });
});

test("removal keeps native and external activity visible after archive and denies busy or unknown owners", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "remove activity");
    const filePath = join(root, "catalog.json");
    let nativeState: "idle" | "busy" | "unknown" = "busy";
    let externalState: "idle" | "busy" | "unknown" = "idle";
    const service = createRemovalService(filePath, {
      async readNative() {
        return { complete: nativeState !== "unknown", state: nativeState };
      },
      async readExternal() {
        return { complete: externalState !== "unknown", state: externalState };
      },
    });
    const linked = await adoptLinkedWorkspace(service, fixture.linked);
    const nativeBusy = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.ok(nativeBusy.blockers.includes("native-busy"));

    nativeState = "idle";
    await service.updateWorkspace({ operation: "archive", workspaceId: linked.id });
    externalState = "busy";
    const archivedExternalBusy = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.ok(archivedExternalBusy.blockers.includes("external-busy"));

    externalState = "idle";
    const idlePreview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.equal(idlePreview.safeToRemove, true);
    externalState = "unknown";
    await assert.rejects(
      service.removeWorkspace({
        workspaceId: linked.id,
        expectedGeneration: linked.generation,
        confirmationToken: idlePreview.confirmationToken!,
      }),
      /workspace-removal-blocked:external-unknown/,
    );
    assert.equal(await readFile(join(fixture.linked, "README.md"), "utf8"), "initial\n");
    const externalUnknown = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.ok(externalUnknown.blockers.includes("external-unknown"));
  });
});

test("stale removal token or generation is rejected without touching the worktree", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "remove stale");
    const service = createRemovalService(join(root, "catalog.json"));
    const linked = await adoptLinkedWorkspace(service, fixture.linked);
    const preview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    await assert.rejects(
      service.removeWorkspace({
        workspaceId: linked.id,
        expectedGeneration: "stale-generation",
        confirmationToken: preview.confirmationToken!,
      }),
      /stale-generation|confirmation/i,
    );
    assert.equal(await readFile(join(fixture.linked, "README.md"), "utf8"), "initial\n");
    await assert.rejects(
      service.removeWorkspace({
        workspaceId: linked.id,
        expectedGeneration: linked.generation,
        confirmationToken: "not-a-preview-token",
      }),
      /confirmation/i,
    );
  });
});

test("remove freezes native and external admission across independent Host instances", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "remove host fence");
    const filePath = join(root, "catalog.json");
    const admissionRoot = `${filePath}.admission`;
    const firstHost = createNodeWorkspaceAdmissionController({
      root: admissionRoot,
      targetId: () => "target-local",
    });
    const secondHost = createNodeWorkspaceAdmissionController({
      root: admissionRoot,
      targetId: () => "target-local",
    });
    let checkFrozen = false;
    const admissionRequest = (workspace: {
      id: string;
      worktreeGeneration: string;
      worktreePath: string;
    }) => ({
      targetId: "target-local",
      workspaceId: workspace.id,
      workspacePath: workspace.worktreePath,
      expectedGeneration: workspace.worktreeGeneration,
    });
    const activity = {
      async readNative(workspace: {
        id: string;
        worktreeGeneration: string;
        worktreePath: string;
      }) {
        if (checkFrozen) {
          await assert.rejects(
            firstHost.withWorkspace(admissionRequest(workspace), async () => undefined),
            /workspace-admission-frozen/,
          );
        }
        return { complete: true, state: "idle" as const };
      },
      async readExternal(workspace: {
        id: string;
        worktreeGeneration: string;
        worktreePath: string;
      }) {
        if (checkFrozen) {
          await assert.rejects(
            secondHost.withWorkspace(admissionRequest(workspace), async () => undefined),
            /workspace-admission-frozen/,
          );
        }
        return { complete: true, state: "idle" as const };
      },
    };
    const service = createFileWorktreeService({
      filePath,
      targetId: () => "target-local",
      admissionRoot,
      admissionController: firstHost,
      activity,
    });
    const linked = await adoptLinkedWorkspace(service, fixture.linked);
    await assert.rejects(
      firstHost.withWorkspace(
        { ...admissionRequest(linked), targetId: "foreign-target" },
        async () => undefined,
      ),
      /workspace-admission-target-mismatch/,
    );
    const preview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    checkFrozen = true;
    await service.removeWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
      confirmationToken: preview.confirmationToken!,
    });
    await assert.rejects(
      secondHost.withWorkspace(
        admissionRequest({
          id: linked.id,
          worktreeGeneration: linked.generation,
          worktreePath: fixture.linked,
        }),
        async () => undefined,
      ),
      /workspace-admission-removed/,
    );
  });
});

test("accepted work crossing freeze blocks removal and a Git refusal is safely retryable", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "remove retry");
    const filePath = join(root, "catalog.json");
    const admissionRoot = `${filePath}.admission`;
    const admission = createNodeWorkspaceAdmissionController({
      root: admissionRoot,
      targetId: () => "target-local",
    });
    let pendingCommandCount = 0;
    let pendingInputCount = 0;
    let failGitRemove = true;
    let gitRemoveCalls = 0;
    const git = {
      async run(args: readonly string[]) {
        if (args.includes("remove")) {
          gitRemoveCalls += 1;
          if (failGitRemove) return { stdout: "", stderr: "synthetic remove refusal", exitCode: 1 };
        }
        return nodeWorktreeGitExec.run(args);
      },
    };
    const service = createFileWorktreeService({
      filePath,
      targetId: () => "target-local",
      admissionRoot,
      admissionController: admission,
      git,
      activity: {
        async readNative() {
          return {
            complete: true,
            state: "idle" as const,
            pendingCommandCount,
            pendingInputCount,
          };
        },
        async readExternal() {
          return { complete: true, state: "idle" as const };
        },
      },
    });
    const linked = await adoptLinkedWorkspace(service, fixture.linked);
    const request = {
      targetId: "target-local",
      workspaceId: linked.id,
      workspacePath: fixture.linked,
      expectedGeneration: linked.generation,
    };
    const heldPreview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    await admission.withWorkspace(request, async () => {
      // CommandInbox 已接受并 pin 的 held/queued 输入在释放 fence 后仍由 owner 持有。
      pendingInputCount = 1;
    });
    await assert.rejects(
      service.removeWorkspace({
        workspaceId: linked.id,
        expectedGeneration: linked.generation,
        confirmationToken: heldPreview.confirmationToken!,
      }),
      /workspace-removal-blocked:native-busy/,
    );
    assert.equal(pendingInputCount, 1, "a denied removal leaves the accepted queue item untouched");
    assert.equal(gitRemoveCalls, 0);
    assert.equal(await readFile(join(fixture.linked, "README.md"), "utf8"), "initial\n");
    pendingInputCount = 0;

    const inFlightPreview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    await admission.withWorkspace(request, async () => {
      pendingCommandCount = 1;
    });
    await assert.rejects(
      service.removeWorkspace({
        workspaceId: linked.id,
        expectedGeneration: linked.generation,
        confirmationToken: inFlightPreview.confirmationToken!,
      }),
      /workspace-removal-blocked:native-busy/,
    );
    assert.equal(
      pendingCommandCount,
      1,
      "a denied removal leaves accepted command state untouched",
    );
    assert.equal(gitRemoveCalls, 0);
    pendingCommandCount = 0;

    const refusedPreview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    await assert.rejects(
      service.removeWorkspace({
        workspaceId: linked.id,
        expectedGeneration: linked.generation,
        confirmationToken: refusedPreview.confirmationToken!,
      }),
      /git-worktree-remove-failed/,
    );
    assert.equal(gitRemoveCalls, 1);
    assert.equal(await readFile(join(fixture.linked, "README.md"), "utf8"), "initial\n");
    failGitRemove = false;
    const retryPreview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    const removed = await service.removeWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
      confirmationToken: retryPreview.confirmationToken!,
    });
    assert.equal(removed.lifecycle, "removed");
    assert.equal(gitRemoveCalls, 2);
  });
});

test("Git success with a metadata failure stays fenced and retries by reconciling, without a second remove", async () => {
  await withWorktree(async (root) => {
    const fixture = await createRepository(root, "remove metadata recovery");
    const filePath = join(root, "catalog.json");
    const filePersistence = createFileWorktreePersistence(filePath);
    const admissionRoot = `${filePath}.admission`;
    const admission = createNodeWorkspaceAdmissionController({
      root: admissionRoot,
      targetId: () => "target-local",
    });
    let failRemovedWrite = true;
    let gitRemoveCalls = 0;
    const persistence = {
      read: () => filePersistence.read(),
      async update(mutator: Parameters<typeof filePersistence.update>[0]) {
        const current = await filePersistence.read();
        const candidate = mutator(current);
        if (failRemovedWrite && candidate.workspaces.some((item) => item.lifecycle === "removed")) {
          failRemovedWrite = false;
          throw new Error("synthetic catalog persistence failure");
        }
        return filePersistence.update(mutator);
      },
    };
    const git = {
      async run(args: readonly string[]) {
        if (args.includes("remove")) gitRemoveCalls += 1;
        return nodeWorktreeGitExec.run(args);
      },
    };
    const service = createFileWorktreeService({
      filePath,
      targetId: () => "target-local",
      admissionRoot,
      admissionController: admission,
      persistence,
      git,
      activity: provenIdleActivity,
    });
    const linked = await adoptLinkedWorkspace(service, fixture.linked);
    const preview = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    await assert.rejects(
      service.removeWorkspace({
        workspaceId: linked.id,
        expectedGeneration: linked.generation,
        confirmationToken: preview.confirmationToken!,
      }),
      /synthetic catalog persistence failure/,
    );
    assert.equal(gitRemoveCalls, 1);
    const recovery = await service.previewRemoveWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
    });
    assert.equal(recovery.safeToRemove, true);
    const removed = await service.removeWorkspace({
      workspaceId: linked.id,
      expectedGeneration: linked.generation,
      confirmationToken: recovery.confirmationToken!,
    });
    assert.equal(removed.lifecycle, "removed");
    assert.equal(gitRemoveCalls, 1);
  });
});
