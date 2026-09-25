import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createLazyWorkspaceComposition } from "../src/workspace-hierarchy/lazyComposition.js";
import { createLocalServices } from "../src/node.js";
import type { ProviderRegistryService } from "@zcode/provider";

const registry = { async start() {} } as ProviderRegistryService;
const facts = {
  nativeIndex: {
    async allSessions() {
      return [];
    },
    async workspaceFreshness() {
      return "live" as const;
    },
  },
  native: {
    async resolveOwner() {
      return undefined;
    },
    async create() {
      throw Error("not native");
    },
    async capabilities() {
      throw Error("not native");
    },
  },
  nativeActivity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  nativeAdmissionFence: async () => ({ verify: async () => true, release: async () => {} }),
};

test("real lazy Target/Catalog factory serves reads during pending reconciliation but fences NEW admissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-boot-"));
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const composition = createLazyWorkspaceComposition({
    root,
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux" | "win32",
      available: true,
    },
    registry,
    identity: (_id, cwd) => cwd,
    ...facts,
    newAdmissionsEnabled: () => true,
    reconcileBoot: async () => {
      await pending;
    },
  });
  try {
    assert.equal((await composition.catalog.sidebarSnapshot()).projects.length, 0);
    assert.equal((await composition.agentHost.getAvailability()).admissionEnabled, false);
    await assert.rejects(
      composition.catalog.importProject({
        id: "p",
        bindingId: "b",
        targetId: "local",
        name: "test",
        repositoryPath: root,
      }),
      /reconcil|pending/i,
    );
    release();
    await composition.ready();
    assert.equal((await composition.agentHost.getAvailability()).admissionEnabled, true);
  } finally {
    release();
    await composition.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real Catalog import cannot overtake held maintenance lease", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-maintenance-catalog-"));
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args]);
  git("init", "-q");
  git(
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
  let nativeHeld = false;
  const composition = createLazyWorkspaceComposition({
    root,
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux" | "win32",
      available: true,
    },
    registry,
    identity: (_id, cwd) => cwd,
    ...facts,
    nativeAdmissionFence: async () => {
      nativeHeld = true;
      return {
        verify: async () => nativeHeld,
        release: async () => {
          nativeHeld = false;
        },
      };
    },
    newAdmissionsEnabled: () => true,
    reconcileBoot: async (catalog) => {
      await catalog.reconcilePending();
      await catalog.reconcileArchivePolicies();
    },
  });
  const request = {
    id: "p",
    bindingId: "b",
    targetId: "local",
    name: "Repo",
    repositoryPath: repo,
  };
  try {
    await composition.ready();
    const lease = await composition.maintenance.freezeAdmissions();
    assert.equal(nativeHeld, true);
    await assert.rejects(composition.catalog.importProject(request), /frozen/);
    assert.equal((await composition.catalog.sidebarSnapshot()).projects.length, 0);
    await composition.maintenance.releaseAdmissions(lease);
    assert.equal(nativeHeld, false);
    await composition.catalog.importProject(request);
    assert.equal((await composition.catalog.sidebarSnapshot()).projects.length, 1);
    const workspace = await composition.catalog.adopt({
      bindingId: "b",
      workspaceId: "w",
      title: "Main",
      worktreePath: repo,
    });
    assert.deepEqual(await composition.hierarchy.pendingRecovery({ workspaceId: "w" }), {
      workspaceId: "w",
      status: "confirmed",
      reason: "target-receipt-confirmed",
      generation: workspace.worktreeGeneration,
      receiptKind: "adopt",
      actions: ["inspect"],
    });
  } finally {
    await composition.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Core preflight rejects missing facts and unauthenticated remote target before any service starts", () => {
  const basic = {
    zcodeBuiltinProviderConfigFilePath: "/nonexistent-test-provider-config",
    serviceAuthorityMode: "standalone-server" as const,
    agentHostTargetId: "target",
  };
  assert.throws(() => createLocalServices(basic), /persistent root.*native bridge/);
  assert.throws(
    () =>
      createLocalServices({
        ...basic,
        workspaceCompositionRoot: "relative",
        workspaceComposition: facts,
      }),
    /persistent root.*native bridge/,
  );
  assert.throws(
    () =>
      createLocalServices({
        ...basic,
        workspaceCompositionRoot: "/tmp/workspace-boot-test",
        workspaceComposition: facts,
        workspaceCompositionTarget: {
          id: "target",
          kind: "ssh",
          platform: process.platform as "darwin" | "linux" | "win32",
          available: true,
        },
      }),
    /trusted target/,
  );
});

test("disposal while reconciliation is in flight closes admission and never re-runs boot", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-boot-dispose-"));
  let release!: () => void;
  let reconciliations = 0;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const composition = createLazyWorkspaceComposition({
    root,
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux" | "win32",
      available: true,
    },
    registry,
    identity: (_id, cwd) => cwd,
    ...facts,
    newAdmissionsEnabled: () => true,
    reconcileBoot: async () => {
      reconciliations++;
      await pending;
    },
  });
  try {
    await composition.catalog.sidebarSnapshot();
    const disposed = composition.dispose();
    release();
    await disposed;
    assert.equal(reconciliations, 1);
    await assert.rejects(composition.ready(), /disposed/);
    assert.equal((await composition.agentHost.getAvailability()).admissionEnabled, false);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed boot reconciliation keeps real factory read-only and history reachable", async () => {
  const root = await mkdtemp(join(tmpdir(), "workspace-boot-"));
  let attempts = 0;
  const composition = createLazyWorkspaceComposition({
    root,
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux" | "win32",
      available: true,
    },
    registry,
    identity: (_id, cwd) => cwd,
    ...facts,
    newAdmissionsEnabled: () => true,
    reconcileBoot: async () => {
      attempts++;
      throw Error("catalog-target-result-unknown");
    },
  });
  try {
    assert.equal((await composition.catalog.sidebarSnapshot()).projects.length, 0);
    await assert.rejects(composition.ready(), /catalog-target-result-unknown/);
    assert.equal((await composition.agentHost.getAvailability()).admissionEnabled, false);
    assert.equal((await composition.catalog.sidebarSnapshot()).projects.length, 0);
    await assert.rejects(composition.catalog.create({} as never), /reconcil|unknown/i);
    await assert.rejects(composition.ready(), /catalog-target-result-unknown/);
    await assert.rejects(composition.catalog.reconcilePending(), /Core owns boot reconciliation/);
    assert.equal(attempts, 1);
  } finally {
    await composition.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
