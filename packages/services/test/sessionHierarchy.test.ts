import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import {
  sessionHierarchyFileSchema,
  sessionHierarchyRecordSchema,
} from "@zcode/shared/agent-host/session-hierarchy";
import { createSessionHierarchyService } from "../src/session-hierarchy/app/service.js";
import { createAgentHostSessionSource } from "../src/session-hierarchy/app/externalSessionSource.js";
import { createTaskIndexSessionSource } from "../src/session-hierarchy/app/taskIndexSource.js";
import { createSessionHierarchyFilePersistence } from "../src/session-hierarchy/adapters/filePersistence.js";
import { createFileWorktreeService } from "../src/worktree/index.js";
import type { SessionIndexPort } from "../src/session-hierarchy/contract.js";

const execFile = promisify(execFileCallback);

async function git(cwd: string, args: readonly string[]): Promise<void> {
  await execFile("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function withFixture<T>(run: (path: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "zcode-session-hierarchy-"));
  try {
    return await run(join(root, "sidecar.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function service(
  filePath: string,
  locators: readonly Record<string, unknown>[],
  workspaces: readonly Record<string, unknown>[],
  options: {
    index?: SessionIndexPort;
    external?: {
      listPersistedExternalSessionLocators: (
        workspaces: readonly unknown[],
      ) => Promise<readonly Record<string, unknown>[]>;
    };
    currentOwners?: {
      listCurrentOwnerSessionLocators: (
        workspaces: readonly unknown[],
      ) => Promise<readonly Record<string, unknown>[]>;
    };
    discover?: (inputPath: string) => Promise<{
      kind: "nonGit" | "git" | "bare";
      reason?: "not-git" | "missing-path";
      candidates: readonly { worktreePath: string }[];
    }>;
  } = {},
) {
  return createSessionHierarchyService({
    index: options.index ?? { listPersistedSessionLocators: async () => locators as never },
    worktrees: {
      read: async () => ({ workspaces }),
      ...(options.discover ? { discover: options.discover } : {}),
    },
    ...(options.external ? { external: options.external as never } : {}),
    ...(options.currentOwners ? { currentOwners: options.currentOwners as never } : {}),
    persistence: createSessionHierarchyFilePersistence(filePath),
    targetId: () => "target-local",
    knownHarnessIds: ["zcode", "pi"],
  });
}

test("preview reads persisted locators, links three sessions, preserves child cwd, and is repeatable", async () => {
  await withFixture(async (filePath) => {
    const locators = [0, 1, 2].map((index) => ({
      sourceKey: `task-${index}`,
      nativeSessionId: `native-${index}`,
      targetId: "target-local",
      workspacePath: "/repo",
      cwd: index === 0 ? "/repo/packages/app" : "/repo",
      harnessId: "zcode",
      modelSelection: { providerId: "p", modelId: "m" },
    }));
    const workspaces = [
      {
        targetId: "target-local",
        projectId: "project-one",
        workspaceId: "workspace-main",
        worktreePath: "/repo",
        worktreeGeneration: "generation-main",
        lifecycle: "active",
        verification: "verified",
      },
    ];
    const first = service(filePath, locators, workspaces);
    const preview = await first.preview();
    assert.equal(preview.records.length, 3);
    assert.equal(
      preview.records.every((record) => record.status === "linked"),
      true,
    );
    assert.equal(
      preview.records.find((record) => record.nativeSessionId === "native-0")
        ?.cwdRelativeToWorktree,
      "packages/app",
    );
    await first.apply({ source: preview.source, expectedCurrentRevision: null });
    const second = await service(filePath, locators, workspaces).preview();
    assert.deepEqual(second, preview);
    assert.equal(new Set(preview.records.map((record) => record.hierarchySessionId)).size, 3);
  });
});

test("current hierarchy read merges confirmed migration rows with exact owner associations only", async () => {
  await withFixture(async (filePath) => {
    const oldLocator = {
      sourceKey: "legacy-owner",
      nativeSessionId: "legacy-session",
      targetId: "target-local",
      workspacePath: "/repo",
      cwd: "/repo",
      harnessId: "zcode",
    };
    const workspace = {
      targetId: "target-local",
      projectId: "project",
      workspaceId: "workspace",
      worktreePath: "/repo",
      worktreeGeneration: "generation-1",
      lifecycle: "active",
      verification: "verified",
    };
    const initial = service(filePath, [oldLocator], [workspace], {
      discover: async () => ({ kind: "git", candidates: [{ worktreePath: "/repo" }] }),
    });
    const preview = await initial.preview();
    await initial.apply({ source: preview.source, expectedCurrentRevision: null });

    const current = await service(filePath, [], [workspace], {
      index: {
        async listPersistedSessionLocators() {
          throw new Error("current read must not rerun legacy migration");
        },
      },
      currentOwners: {
        async listCurrentOwnerSessionLocators() {
          return [
            {
              sourceKey: "/repo:managed-session",
              nativeSessionId: "managed-session",
              ownerKind: "native-v4",
              targetId: "target-local",
              workspacePath: "/repo",
              cwd: "/repo",
              workspaceId: "workspace",
              worktreeGeneration: "generation-1",
              harnessId: "zcode",
              title: "Managed Agent",
            },
          ];
        },
      },
    }).read();

    assert.deepEqual(current?.records.map((record) => record.nativeSessionId).sort(), [
      "legacy-session",
      "managed-session",
    ]);
    assert.equal(
      current?.records.find((record) => record.nativeSessionId === "legacy-session")
        ?.ownerAssociation,
      undefined,
    );
    assert.deepEqual(
      current?.records.find((record) => record.nativeSessionId === "managed-session")
        ?.ownerAssociation,
      { workspaceId: "workspace", worktreeGeneration: "generation-1" },
    );
  });
});

test("fingerprint includes nested locator/worktree facts but ignores source ordering", async () => {
  await withFixture(async (filePath) => {
    const locators = [
      {
        sourceKey: "a",
        nativeSessionId: "native-a",
        targetId: "target-local",
        workspacePath: "/repo",
        cwd: "/repo",
        harnessId: "zcode",
        modelSelection: { providerId: "p", modelId: "m" },
      },
      {
        sourceKey: "b",
        nativeSessionId: "native-b",
        targetId: "target-local",
        workspacePath: "/repo",
        cwd: "/repo/sub",
        harnessId: "zcode",
        modelSelection: { providerId: "p", modelId: "m" },
      },
    ];
    const workspaces = [
      {
        targetId: "target-local",
        projectId: "p",
        workspaceId: "w",
        worktreePath: "/repo",
        worktreeGeneration: "generation-w",
        lifecycle: "active",
        verification: "verified",
      },
    ];
    const first = await service(filePath, locators, workspaces).preview();
    const reordered = await service(
      filePath,
      [...locators].reverse(),
      [...workspaces].reverse(),
    ).preview();
    assert.equal(reordered.source.fingerprint, first.source.fingerprint);
    const changed = await service(
      filePath,
      [{ ...locators[0]!, cwd: "/repo/changed" }, locators[1]!],
      workspaces,
    ).preview();
    assert.notEqual(changed.source.fingerprint, first.source.fingerprint);
    const changedWorkspace = await service(filePath, locators, [
      {
        ...workspaces[0]!,
        workspaceId: "w-rebuilt",
        worktreeGeneration: "generation-rebuilt",
      },
    ]).preview();
    assert.notEqual(changedWorkspace.source.fingerprint, first.source.fingerprint);
    const changedModel = await service(
      filePath,
      [{ ...locators[0]!, modelSelection: { providerId: "p", modelId: "changed" } }, locators[1]!],
      workspaces,
    ).preview();
    assert.notEqual(changedModel.source.fingerprint, first.source.fingerprint);
    const changedTarget = await service(
      filePath,
      [{ ...locators[0]!, targetId: "target-other" }, locators[1]!],
      workspaces,
    ).preview();
    assert.notEqual(changedTarget.source.fingerprint, first.source.fingerprint);
  });
});

test("apply recomputes records, rejects forged/stale previews, and preserves sidecar backup", async () => {
  await withFixture(async (filePath) => {
    const locators = [
      {
        sourceKey: "a",
        nativeSessionId: "native-a",
        targetId: "target-local",
        workspacePath: "/repo",
        cwd: "/repo",
        harnessId: "zcode",
        modelSelection: { providerId: "p", modelId: "m" },
      },
    ];
    const svc = service(filePath, locators, []);
    const preview = await svc.preview();
    const forged = {
      ...preview,
      records: [
        {
          ...preview.records[0]!,
          status: "linked",
          projectId: "forged",
          workspaceId: "forged",
          harnessId: "zcode",
          cwdRelativeToWorktree: ".",
        },
      ],
    };
    const applied = await svc.apply({ source: forged.source, expectedCurrentRevision: null });
    assert.equal(applied.records[0]?.status, "pending-verification");
    assert.equal(applied.records[0]?.projectId, undefined);
    await assert.rejects(
      svc.apply({
        source: { ...preview.source, fingerprint: "0".repeat(64) },
        expectedCurrentRevision: applied.source.commandKey,
      }),
      /stale/,
    );
    (locators[0] as { cwd: string }).cwd = "/repo/changed";
    const changedSource = await svc.preview();
    await assert.rejects(
      svc.apply({ source: preview.source, expectedCurrentRevision: null }),
      /stale/,
    );
    const second = await svc.apply({
      source: changedSource.source,
      expectedCurrentRevision: applied.source.commandKey,
    });
    assert.equal(second.source.fingerprint, changedSource.source.fingerprint);
    assert.equal(
      await readFile(`${filePath}.bak`, "utf8")
        .then(() => true)
        .catch(() => false),
      true,
    );
  });
});

test("same path and identity on different targets stay isolated and unresolved facts preserve history", async () => {
  await withFixture(async (filePath) => {
    const locators = [
      {
        sourceKey: "a",
        nativeSessionId: "native-a",
        targetId: "target-a",
        workspacePath: "/repo",
        workspaceIdentity: "shared-workspace-key",
        cwd: "/repo",
        harnessId: "zcode",
        modelSelection: { providerId: "p", modelId: "m" },
      },
      {
        sourceKey: "b",
        nativeSessionId: "native-b",
        targetId: "target-b",
        workspacePath: "/repo",
        workspaceIdentity: "shared-workspace-key",
        cwd: "/repo",
        harnessId: "zcode",
        modelSelection: { providerId: "p", modelId: "m" },
      },
      {
        sourceKey: "c",
        nativeSessionId: "native-c",
        targetId: "target-a",
        workspacePath: "/missing",
        cwd: "/missing",
        harnessId: "unknown",
        modelSelection: { providerId: "p", modelId: "m" },
      },
    ];
    const result = await service(filePath, locators, [
      {
        targetId: "target-a",
        projectId: "p",
        workspaceId: "w-a",
        worktreePath: "/repo",
        workspaceIdentity: "shared-workspace-key",
        worktreeGeneration: "generation-a",
        lifecycle: "active",
        verification: "verified",
      },
    ]).preview();
    assert.equal(
      result.records.find((record) => record.nativeSessionId === "native-a")?.status,
      "linked",
    );
    assert.equal(
      result.records.find((record) => record.nativeSessionId === "native-b")?.status,
      "pending-verification",
    );
    assert.equal(
      result.records.find((record) => record.nativeSessionId === "native-b")?.pendingReason,
      "workspace-not-adopted",
    );
    assert.equal(
      result.records.find((record) => record.nativeSessionId === "native-c")?.pendingReason,
      "workspace-not-adopted",
    );
    await service(filePath, locators, [
      {
        targetId: "target-a",
        projectId: "p",
        workspaceId: "w-a",
        worktreePath: "/repo",
        workspaceIdentity: "shared-workspace-key",
        worktreeGeneration: "generation-a",
        lifecycle: "active",
        verification: "verified",
      },
    ]).apply({ source: result.source, expectedCurrentRevision: null });
    assert.deepEqual(JSON.parse(await readFile(filePath, "utf8")), result);
  });
});

test("legacy V1 identity trimmed from a whitespace path remains verification-only", async () => {
  await withFixture(async (filePath) => {
    const originalPath = "/repo with space \n";
    const result = await service(
      filePath,
      [
        {
          sourceKey: "legacy-v1",
          nativeSessionId: "native-v1-whitespace",
          ownerKind: "native-v4",
          targetId: "target-a",
          workspaceId: "workspace-a",
          worktreeGeneration: "generation-current",
          workspacePath: originalPath,
          workspaceIdentity: originalPath.trim(),
          cwd: originalPath,
          harnessId: "zcode",
        },
      ],
      [
        {
          targetId: "target-a",
          projectId: "project-a",
          workspaceId: "workspace-a",
          worktreePath: originalPath,
          worktreeGeneration: "generation-current",
          lifecycle: "active",
          verification: "verified",
        },
      ],
    ).preview();
    const record = result.records[0];
    assert.equal(record?.nativeSessionId, "native-v1-whitespace");
    assert.equal(record?.workspacePath, originalPath);
    assert.equal(record?.workspaceIdentity, originalPath.trim());
    assert.equal(record?.status, "pending-verification");
    assert.equal(record?.pendingReason, "identity-mismatch");
    assert.equal(record?.ownerAssociation, undefined);
    assert.equal(record?.ownerHistoryAssociation?.worktreeGeneration, "generation-current");
  });
});

test("future sidecar refuses apply and repeated apply does not rebuild IDs", async () => {
  await withFixture(async (filePath) => {
    const svc = service(
      filePath,
      [{ sourceKey: "a", nativeSessionId: "n", workspacePath: "/repo" }],
      [],
    );
    const preview = await svc.preview();
    const applied = await svc.apply({ source: preview.source, expectedCurrentRevision: null });
    assert.deepEqual(
      await svc.apply({
        source: preview.source,
        expectedCurrentRevision: applied.source.commandKey,
      }),
      applied,
    );
    const future = JSON.stringify({ schemaVersion: 99, source: preview.source, records: [] });
    await writeFile(filePath, future, "utf8");
    await assert.rejects(svc.read(), /version|expected|invalid/i);
    assert.equal(await readFile(filePath, "utf8"), future);
  });
});

test("versioned rollback restores absence and protects later revisions", async () => {
  await withFixture(async (filePath) => {
    const locators = [
      {
        sourceKey: "a",
        nativeSessionId: "native-a",
        workspacePath: "/repo",
      },
    ];
    const svc = service(filePath, locators, []);
    const firstPreview = await svc.preview();
    const first = await svc.apply({ source: firstPreview.source, expectedCurrentRevision: null });
    const firstBackup = JSON.parse(await readFile(`${filePath}.bak`, "utf8")) as {
      schemaVersion: number;
      appliedRevision: string;
      previous: unknown;
    };
    assert.equal(firstBackup.schemaVersion, 1);
    assert.equal(firstBackup.appliedRevision, first.source.commandKey);
    assert.equal(firstBackup.previous, null);
    assert.deepEqual(
      await svc.apply({
        source: firstPreview.source,
        expectedCurrentRevision: "wrong-but-idempotent",
      }),
      first,
    );
    assert.deepEqual(JSON.parse(await readFile(`${filePath}.bak`, "utf8")), firstBackup);
    assert.equal(await svc.rollback(first.source.commandKey), null);
    assert.equal(await svc.read(), null);
    await assert.rejects(readFile(filePath), /ENOENT/);

    const firstAgain = await svc.apply({
      source: firstPreview.source,
      expectedCurrentRevision: null,
    });
    (locators[0] as { cwd: string }).cwd = "/repo/new";
    const secondPreview = await svc.preview();
    const second = await svc.apply({
      source: secondPreview.source,
      expectedCurrentRevision: firstAgain.source.commandKey,
    });
    const secondBackup = JSON.parse(await readFile(`${filePath}.bak`, "utf8")) as {
      appliedRevision: string;
      previous: { source: { commandKey: string } } | null;
    };
    assert.equal(secondBackup.appliedRevision, second.source.commandKey);
    assert.equal(secondBackup.previous?.source.commandKey, firstAgain.source.commandKey);
    await assert.rejects(svc.rollback(firstAgain.source.commandKey), /stale/);
    const restored = await svc.rollback(second.source.commandKey);
    assert.equal(restored?.source.commandKey, firstAgain.source.commandKey);
    assert.deepEqual(await svc.read(), firstAgain);
  });
});

test("concurrent services accept the current token once and reject a stale token", async () => {
  await withFixture(async (filePath) => {
    const locators = [
      {
        sourceKey: "a",
        nativeSessionId: "native-a",
        workspacePath: "/repo",
      },
    ];
    const firstService = service(filePath, locators, []);
    const secondService = service(filePath, locators, []);
    const oldPreview = await firstService.preview();
    (locators[0] as { cwd: string }).cwd = "/repo/changed";
    const newPreview = await secondService.preview();
    const results = await Promise.allSettled([
      firstService.apply({ source: oldPreview.source, expectedCurrentRevision: null }),
      secondService.apply({ source: newPreview.source, expectedCurrentRevision: null }),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const applied = results.find((result) => result.status === "fulfilled");
    assert.equal(
      applied?.status === "fulfilled" ? applied.value.source.commandKey : undefined,
      newPreview.source.commandKey,
    );
  });
});

test("external Host manifests join adopted workspaces with an explicit owner kind", async () => {
  await withFixture(async (filePath) => {
    const externalSource = createAgentHostSessionSource({
      async listSessions() {
        return [
          {
            spec: {
              schemaVersion: 1,
              hostSessionId: "host-1",
              execution: {
                targetId: "target-local",
                workspaceIdentity: "/repo",
                worktreePath: "/repo",
              },
              harness: { id: "pi", adapterVersion: "1" },
              modelBinding: {
                kind: "host-managed",
                selection: { providerId: "p", modelId: "m" },
              },
            },
            state: "terminated",
            updatedAt: 1,
          },
          {
            spec: {
              schemaVersion: 1,
              hostSessionId: "host-2",
              execution: {
                targetId: "target-local",
                workspaceIdentity: "/repo",
                worktreePath: "/repo",
              },
              harness: { id: "pi", adapterVersion: "1" },
              modelBinding: { kind: "harness-managed", nativeModelId: "native-model" },
            },
            state: "running",
            updatedAt: 2,
          },
        ] as never;
      },
    });
    const locators = [
      {
        sourceKey: "native-subdir",
        nativeSessionId: "host-1",
        ownerKind: "native-v4" as const,
        targetId: "target-local",
        workspacePath: "/repo/packages/app",
        cwd: "/repo/packages/app",
        harnessId: "zcode",
        modelSelection: { providerId: "p", modelId: "m" },
      },
    ];
    const result = await service(
      filePath,
      locators,
      [
        {
          targetId: "target-local",
          projectId: "project",
          workspaceId: "workspace",
          worktreePath: "/repo",
          worktreeGeneration: "generation",
          lifecycle: "active",
          verification: "verified",
        },
      ],
      {
        external: externalSource as never,
        discover: async () => ({ kind: "git", candidates: [{ worktreePath: "/repo" }] }),
      },
    ).preview();
    const native = result.records.find((record) => record.ownerKind === "native-v4");
    const external = result.records.find((record) => record.nativeSessionId === "host-1");
    const harnessManaged = result.records.find((record) => record.nativeSessionId === "host-2");
    assert.equal(native?.ownerKind, "native-v4");
    assert.equal(native?.cwdRelativeToWorktree, "packages/app");
    assert.equal(external?.ownerKind, "agent-host");
    assert.equal(external?.harnessId, "pi");
    assert.equal(external?.cwdRelativeToWorktree, ".");
    assert.equal(external?.modelSelection?.modelId, "m");
    assert.equal(harnessManaged?.status, "linked");
    assert.equal(harnessManaged?.modelSelection, undefined);
    assert.notEqual(native?.hierarchySessionId, external?.hierarchySessionId);
  });
});

test("real Worktree discovery maps subdirectories to the right nested repository root", async () => {
  await withFixture(async (filePath) => {
    const root = join(filePath, "..");
    const outer = join(root, "outer repo");
    const nested = join(outer, "nested repo");
    await git(root, ["init", "-q", "outer repo"]);
    await git(outer, ["config", "user.email", "test@example.com"]);
    await git(outer, ["config", "user.name", "Session Test"]);
    await writeFile(join(outer, "README.md"), "outer\n", "utf8");
    await git(outer, ["add", "README.md"]);
    await git(outer, ["commit", "-qm", "outer"]);
    await mkdir(join(outer, "packages", "app"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await git(nested, ["init", "-q"]);
    await git(nested, ["config", "user.email", "test@example.com"]);
    await git(nested, ["config", "user.name", "Session Test"]);
    await writeFile(join(nested, "README.md"), "nested\n", "utf8");
    await git(nested, ["add", "README.md"]);
    await git(nested, ["commit", "-qm", "nested"]);
    await mkdir(join(nested, "src"), { recursive: true });
    const worktreeService = createFileWorktreeService({
      filePath: join(root, "worktree-catalog.json"),
      targetId: () => "target-local",
    });
    const taskIndexSource = createTaskIndexSessionSource(
      {
        async listTaskMetas() {
          return [
            {
              taskId: "outer-session",
              traceId: "trace-outer",
              title: "outer",
              workspacePath: join(outer, "packages", "app"),
              createdAt: 1,
              updatedAt: 1,
              mode: "build",
            },
            {
              taskId: "nested-session",
              traceId: "trace-nested",
              title: "nested",
              workspacePath: join(nested, "src"),
              createdAt: 1,
              updatedAt: 1,
              mode: "build",
            },
          ] as never;
        },
      },
      "target-local",
    );
    const result = await service(
      filePath,
      [],
      [
        {
          targetId: "target-local",
          projectId: "project",
          workspaceId: "outer-workspace",
          worktreePath: outer,
          worktreeGeneration: "outer-generation",
          lifecycle: "active",
          verification: "verified",
        },
        {
          targetId: "target-local",
          projectId: "project",
          workspaceId: "nested-workspace",
          worktreePath: nested,
          worktreeGeneration: "nested-generation",
          lifecycle: "active",
          verification: "verified",
        },
      ],
      {
        index: taskIndexSource,
        discover: async (inputPath) => {
          const discovery = await worktreeService.discover(inputPath);
          return {
            kind: discovery.kind,
            ...(discovery.kind === "nonGit" ? { reason: discovery.reason } : {}),
            candidates: discovery.kind === "nonGit" ? [] : discovery.candidates,
          };
        },
      },
    ).preview();
    const outerRecord = result.records.find((record) => record.nativeSessionId === "outer-session");
    const nestedRecord = result.records.find(
      (record) => record.nativeSessionId === "nested-session",
    );
    assert.equal(outerRecord?.workspaceId, "outer-workspace");
    assert.equal(outerRecord?.status, "linked");
    assert.equal(outerRecord?.workspacePath, join(outer, "packages", "app"));
    assert.equal(outerRecord?.modelSelection, undefined);
    assert.equal(outerRecord?.cwdRelativeToWorktree, "packages/app");
    assert.equal(nestedRecord?.workspaceId, "nested-workspace");
    assert.equal(nestedRecord?.status, "linked");
    assert.equal(nestedRecord?.workspacePath, join(nested, "src"));
    assert.equal(nestedRecord?.modelSelection, undefined);
    assert.equal(nestedRecord?.cwdRelativeToWorktree, "src");
  });
});

test("strict sidecar schema rejects duplicate locators and incomplete statuses", () => {
  const base = {
    hierarchySessionId: "hierarchy-a",
    nativeSessionId: "native-a",
    targetId: "target-a",
    projectId: "project-a",
    workspaceId: "workspace-a",
    harnessId: "zcode",
    workspacePath: "/repo",
    cwdRelativeToWorktree: ".",
    status: "linked" as const,
  };
  assert.throws(() =>
    sessionHierarchyRecordSchema.parse({ ...base, status: "pending-verification" }),
  );
  assert.throws(() =>
    sessionHierarchyFileSchema.parse({
      schemaVersion: 1,
      source: {
        sourceKey: "session-index:target-a",
        fingerprint: "0".repeat(64),
        commandKey: "1".repeat(64),
      },
      records: [base, { ...base, hierarchySessionId: "hierarchy-b" }],
    }),
  );
});

test("TaskIndex source adapter preserves only persisted target/identity and never fabricates cwd or model", async () => {
  const source = createTaskIndexSessionSource(
    {
      async listTaskMetas() {
        return [
          {
            taskId: "native",
            traceId: "trace",
            title: "old",
            workspacePath: "/repo",
            workspaceIdentity: "remote:host:/repo",
            createdAt: 1,
            updatedAt: 2,
            mode: "build",
          } as never,
        ];
      },
    },
    undefined,
  );
  const [locator] = await source.listPersistedSessionLocators();
  assert.equal(locator?.targetId, undefined);
  assert.equal(locator?.workspaceIdentity, "remote:host:/repo");
  assert.equal(locator?.cwd, undefined);
  assert.equal(locator?.modelSelection, undefined);

  const localSource = createTaskIndexSessionSource(
    {
      async listTaskMetas() {
        return [
          {
            taskId: "local-native",
            traceId: "trace",
            title: "local",
            workspacePath: "/repo",
            createdAt: 1,
            updatedAt: 2,
            mode: "build",
            model: "legacy-model",
          } as never,
        ];
      },
    },
    "target-local",
  );
  const [localLocator] = await localSource.listPersistedSessionLocators();
  assert.equal(localLocator?.targetId, "target-local");
  assert.equal(localLocator?.harnessId, "zcode");
  assert.equal(localLocator?.cwd, "/repo");
  assert.equal(localLocator?.legacyModelId, "legacy-model");
});
