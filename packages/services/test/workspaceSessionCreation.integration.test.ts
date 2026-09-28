import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { WorkspaceSessionCreateRequest } from "@zcode/shared/agent-host";
import { createCurrentOwnerSessionSource } from "../src/session-hierarchy/app/currentOwnerSource.js";
import { createSessionHierarchyService } from "../src/session-hierarchy/app/service.js";
import { createSessionHierarchyFilePersistence } from "../src/session-hierarchy/adapters/filePersistence.js";
import { buildSessionHierarchyPreview } from "../src/session-hierarchy/app/migration.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import {
  createFileWorktreeService,
  createNodeWorkspaceAdmissionController,
} from "../src/worktree/index.js";
import {
  createAgentHostTarget,
  catalog,
  createSqliteNativeOwner,
  git,
  NoCostPi,
  targetId,
} from "./fixtures/workspaceSessionCreation.js";

test("explicit Pi/native owners persist and current hierarchy recovers exact owner facts", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-workspace-session-create-"));
  const repo = join(root, "repo");
  const linked = join(root, "linked-worktree");
  const worktreePath = join(root, "worktrees.json");
  const admissionRoot = join(root, "admission");
  const target = {
    id: targetId,
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const admission = createNodeWorkspaceAdmissionController({
    root: admissionRoot,
    targetId: () => targetId,
  });
  const worktrees = createFileWorktreeService({
    filePath: worktreePath,
    admissionRoot,
    admissionController: admission,
    targetId: () => targetId,
    activity: {
      async readNative() {
        return { complete: true, state: "idle" as const };
      },
      async readExternal() {
        return { complete: true, state: "idle" as const };
      },
    },
  });
  let nativeOwner = createSqliteNativeOwner(join(root, "native-sessions.sqlite"));
  let firstHost: AgentHostTargetService | undefined;
  let restartedHost: AgentHostTargetService | undefined;
  let testPi: NoCostPi | undefined;
  try {
    await git(undefined, ["init", "-q", repo]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Workspace Session Test"]);
    await writeFile(join(repo, "README.md"), "fixture only\n", "utf8");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    await git(repo, ["worktree", "add", "-q", "-b", "session-test", linked]);
    const discovery = await worktrees.discover(linked);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") throw new Error("linked worktree discovery failed");
    const candidate = discovery.candidates.find((item) => item.worktreePath === linked);
    assert.ok(candidate);
    const adopted = await worktrees.adopt("project-session-test", candidate);
    const workspace = adopted.workspace;
    const targetRoot = join(root, "agent-host");

    const createHost = (registry: HarnessRegistry, includeNativeOwner = true) =>
      new AgentHostTargetService({
        root: targetRoot,
        target,
        catalog,
        registry,
        worktrees,
        ...(includeNativeOwner ? { nativeOwner: nativeOwner.port } : {}),
        authorizeWorktree: async (spec, realPath) => {
          const current = (await worktrees.read()).workspaces.find(
            (item) => item.id === spec.execution.workspaceId,
          );
          return Boolean(
            current &&
            current.worktreePath === realPath &&
            spec.execution.worktreeGeneration === current.worktreeGeneration &&
            spec.execution.workspaceIdentity ===
              (current.workspaceIdentity?.trim() || current.worktreePath) &&
            current.lifecycle === "active" &&
            current.verification === "verified",
          );
        },
        withWorkspaceAdmission: async (spec, operation) => {
          const current = (await worktrees.read()).workspaces.find(
            (item) => item.id === spec.execution.workspaceId,
          );
          if (!current || current.worktreeGeneration !== spec.execution.worktreeGeneration) {
            throw new Error("stale-or-unavailable-workspace-generation");
          }
          return admission.withWorkspace(
            {
              targetId,
              workspaceId: current.id,
              workspaceIdentity: current.workspaceIdentity,
              workspacePath: current.worktreePath,
              expectedGeneration: current.worktreeGeneration,
            },
            operation,
          );
        },
        checkAdmissionFence: async (request) => {
          const current = (await worktrees.read()).workspaces.find(
            (item) => item.id === request.id,
          );
          if (!current || current.worktreeGeneration !== request.worktreeGeneration) {
            throw new Error("stale-or-unavailable-workspace-generation");
          }
          const fence = await admission.readFence(current);
          if (
            !fence ||
            fence.targetId !== targetId ||
            fence.workspaceId !== current.id ||
            fence.worktreePath !== current.worktreePath ||
            fence.worktreeGeneration !== current.worktreeGeneration ||
            fence.lifecycle !== "active"
          ) {
            throw new Error(`workspace-admission-${fence?.lifecycle ?? "unregistered"}`);
          }
        },
      });

    testPi = new NoCostPi();
    const registry = new HarnessRegistry();
    registry.register(testPi);
    firstHost = createHost(registry);
    const generation = workspace.worktreeGeneration;
    const request = (
      requestId: string,
      harnessId: string,
      modelBinding: WorkspaceSessionCreateRequest["modelBinding"],
      title?: string,
    ) => ({
      requestId,
      workspaceId: workspace.id,
      worktreeGeneration: generation,
      harnessId,
      modelBinding,
      ...(title ? { title } : {}),
    });
    const piBinding = {
      kind: "host-managed" as const,
      selection: { providerId: "provider-pi", modelId: "model-pi" },
    };
    const nativeBinding = {
      kind: "native-selection" as const,
      selection: { providerId: "provider-native", modelId: "model-native" },
    };
    const nativeRequest = request("create-native-01", "zcode", nativeBinding, "Native Agent");
    nativeOwner.failNextCreateAfterCommit();
    await assert.rejects(
      firstHost.createWorkspaceSession(nativeRequest),
      /simulated-owner-response-loss/,
    );
    const nativeCreated = await firstHost.createWorkspaceSession(nativeRequest);
    assert.equal(nativeCreated.reused, true);
    const piOneRequest = request("create-pi-01", "pi", piBinding, "Pi one");
    const piTwoRequest = request("create-pi-02", "pi", piBinding, "Pi two");
    const [piOne, piTwo] = await Promise.all([
      firstHost.createWorkspaceSession(piOneRequest),
      firstHost.createWorkspaceSession(piTwoRequest),
    ]);
    assert.notEqual(nativeCreated.locator.sessionId, piOne.locator.sessionId);
    assert.notEqual(piOne.locator.sessionId, piTwo.locator.sessionId);
    assert.equal(testPi.creates, 2);
    assert.equal(testPi.modelCalls, 0, "empty owner creation must not invoke the model");
    assert.equal(
      (await worktrees.read()).workspaces.length,
      1,
      "session creation adds no worktree",
    );
    const persistedNative = await nativeOwner.port.lookup({
      targetId,
      sessionId: nativeCreated.locator.sessionId,
      workspacePath: linked,
      workspaceIdentity: linked,
    });
    assert.equal(persistedNative?.association?.workspaceId, workspace.id);
    assert.equal(persistedNative?.association?.worktreeGeneration, generation);
    assert.equal(persistedNative?.title, "Native Agent");

    const createHierarchy = (ownerReader: AgentHostTargetService, sidecarPath: string) => {
      let legacyIndexReads = 0;
      const hierarchy = createSessionHierarchyService({
        index: {
          async listPersistedSessionLocators() {
            legacyIndexReads += 1;
            return [];
          },
        },
        currentOwners: createCurrentOwnerSessionSource(ownerReader),
        worktrees: {
          async read() {
            const current = await worktrees.read();
            return {
              workspaces: current.workspaces.map((item) => ({
                targetId,
                projectId: item.projectId,
                workspaceId: item.id,
                worktreePath: item.worktreePath,
                worktreeGeneration: item.worktreeGeneration,
                ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
                lifecycle: item.lifecycle,
                verification: item.verification,
              })),
            };
          },
        },
        persistence: createSessionHierarchyFilePersistence(sidecarPath),
        targetId: () => targetId,
        knownHarnessIds: ["zcode", "pi"],
      });
      return { hierarchy, legacyIndexReads: () => legacyIndexReads };
    };
    const firstHierarchy = createHierarchy(firstHost, join(root, "hierarchy-sidecar.json"));
    const existingSidecar = buildSessionHierarchyPreview(
      [
        {
          sourceKey: `${linked}:legacy-sidecar-session`,
          nativeSessionId: "legacy-sidecar-session",
          ownerKind: "native-v4",
          targetId,
          workspacePath: linked,
          cwd: linked,
          harnessId: "zcode",
        },
      ],
      [
        {
          targetId,
          projectId: workspace.projectId,
          workspaceId: workspace.id,
          worktreePath: linked,
          worktreeGeneration: generation,
          lifecycle: "active",
          verification: "verified",
        },
      ],
      targetId,
      ["zcode", "pi"],
    );
    await createSessionHierarchyFilePersistence(join(root, "hierarchy-sidecar.json")).update(
      () => existingSidecar,
    );
    const current = await firstHierarchy.hierarchy.read();
    assert.equal(current?.records.length, 4);
    assert.ok(
      current?.records.some((record) => record.nativeSessionId === "legacy-sidecar-session"),
    );
    assert.equal(
      firstHierarchy.legacyIndexReads(),
      0,
      "current read does not rerun legacy migration",
    );
    assert.deepEqual(
      current?.records
        .filter((record) => record.nativeSessionId !== "legacy-sidecar-session")
        .map((record) => record.ownerKind)
        .sort(),
      ["agent-host", "agent-host", "native-v4"],
    );
    assert.equal(
      current?.records.find((record) => record.nativeSessionId === nativeCreated.locator.sessionId)
        ?.ownerAssociation?.worktreeGeneration,
      generation,
    );
    assert.equal(
      current?.records.find((record) => record.nativeSessionId === nativeCreated.locator.sessionId)
        ?.modelSelection?.modelId,
      "model-native",
    );

    await firstHost.close();
    firstHost = undefined;
    nativeOwner.close();
    nativeOwner = createSqliteNativeOwner(join(root, "native-sessions.sqlite"));
    const restartedRegistry = new HarnessRegistry();
    const restartedPi = new NoCostPi();
    restartedRegistry.register(restartedPi);
    const receiptOnlyHost = createHost(restartedRegistry, false);
    const receiptOnlyHierarchy = createHierarchy(
      receiptOnlyHost,
      join(root, "hierarchy-receipt-only.json"),
    );
    const receiptOnlyRead = await receiptOnlyHierarchy.hierarchy.read();
    assert.equal(receiptOnlyRead?.records.length, 3);
    assert.equal(
      receiptOnlyRead?.records.find(
        (record) => record.nativeSessionId === nativeCreated.locator.sessionId,
      )?.ownerHistoryAssociation?.workspaceId,
      workspace.id,
    );
    assert.equal(
      receiptOnlyRead?.records.find(
        (record) => record.nativeSessionId === nativeCreated.locator.sessionId,
      )?.pendingReason,
      "owner-state-unknown",
      "a confirmed creation receipt does not claim current Native runtime state",
    );
    assert.equal(
      receiptOnlyRead?.records.find(
        (record) => record.nativeSessionId === nativeCreated.locator.sessionId,
      )?.ownerAssociation,
      undefined,
    );
    assert.equal(
      receiptOnlyRead?.records.find(
        (record) => record.nativeSessionId === nativeCreated.locator.sessionId,
      )?.modelSelection,
      undefined,
      "offline receipt projection does not copy Native model state",
    );
    await receiptOnlyHost.close();

    restartedHost = createHost(restartedRegistry);
    const restartedHierarchy = createHierarchy(restartedHost, join(root, "hierarchy-sidecar.json"));
    const afterRestart = await restartedHierarchy.hierarchy.read();
    assert.equal(afterRestart?.records.length, 4);
    assert.ok(
      afterRestart?.records.some((record) => record.nativeSessionId === "legacy-sidecar-session"),
      "current membership does not clear a previously applied sidecar mapping",
    );
    assert.equal(
      (await restartedHost.createWorkspaceSession(piOneRequest)).locator.sessionId,
      piOne.locator.sessionId,
    );
    assert.equal(
      (await restartedHost.createWorkspaceSession(nativeRequest)).locator.sessionId,
      nativeCreated.locator.sessionId,
    );
    await assert.rejects(
      restartedHost.createWorkspaceSession({ ...piOneRequest, title: "changed parameters" }),
      /idempotency-conflict/,
    );
    await assert.rejects(
      restartedHost.createWorkspaceSession({
        ...nativeRequest,
        harnessId: "pi",
        modelBinding: piBinding,
      }),
      /idempotency-conflict/,
    );
    let manifestPath: string | undefined;
    for (const entry of await readdir(targetRoot)) {
      if (!entry.endsWith(".session.json")) continue;
      const path = join(targetRoot, entry);
      const manifest = JSON.parse(await readFile(path, "utf8")) as {
        spec?: { hostSessionId?: string };
      };
      if (manifest.spec?.hostSessionId === piOne.locator.sessionId) {
        manifestPath = path;
        break;
      }
    }
    assert.ok(manifestPath);
    const originalManifest = await readFile(manifestPath, "utf8");
    await writeFile(manifestPath, "{corrupt manifest", "utf8");
    const unknownManifestRead = await restartedHierarchy.hierarchy.read();
    assert.equal(unknownManifestRead?.records.length, 4);
    assert.ok(
      unknownManifestRead?.records
        .filter(
          (record) =>
            record.nativeSessionId === piOne.locator.sessionId ||
            record.nativeSessionId === piTwo.locator.sessionId,
        )
        .every(
          (record) =>
            record.status === "pending-verification" &&
            record.pendingReason === "owner-state-unknown" &&
            record.ownerHistoryAssociation?.worktreeGeneration === generation,
        ),
      "creation receipts preserve Pi history without treating corrupt manifests as current owners",
    );
    assert.ok(
      unknownManifestRead?.records.some(
        (record) => record.nativeSessionId === "legacy-sidecar-session",
      ),
      "unreadable owner metadata does not clear the prior sidecar index",
    );
    await writeFile(manifestPath, originalManifest, "utf8");
    assert.equal(restartedPi.creates, 0);
    assert.equal(restartedPi.attaches, 0);
    assert.equal(testPi.modelCalls, 0);
    assert.equal((await worktrees.read()).workspaces.length, 1);

    const offlineHost = new AgentHostTargetService({
      root: targetRoot,
      target: { ...target, available: false },
      catalog,
      registry: new HarnessRegistry(),
      worktrees,
      nativeOwner: nativeOwner.port,
      authorizeWorktree: async () => true,
    });
    await assert.rejects(
      offlineHost.createWorkspaceSession(request("offline-new-session", "zcode", nativeBinding)),
      /execution-target-unavailable/,
    );
    await offlineHost.close();

    await admission.freeze(workspace, "freeze-test", false);
    await assert.rejects(
      restartedHost.createWorkspaceSession(request("freeze-pi", "pi", piBinding)),
      /workspace-admission-frozen/,
    );
    await assert.rejects(
      restartedHost.createWorkspaceSession(request("freeze-native", "zcode", nativeBinding)),
      /workspace-admission-frozen/,
    );
    await admission.finishFreeze(workspace, "freeze-test", "active");
    await assert.rejects(
      restartedHost.createWorkspaceSession({
        ...piTwoRequest,
        requestId: "stale-generation",
        worktreeGeneration: "stale-generation",
      }),
      /stale-or-unavailable-workspace/,
    );

    const displacedWorktreePath = join(root, "displaced-worktree");
    await rename(linked, displacedWorktreePath);
    await mkdir(linked);
    await assert.rejects(
      restartedHost.createWorkspaceSession(request("replaced-directory", "zcode", nativeBinding)),
      /workspace-filesystem-evidence-stale/,
    );
    await rm(linked, { recursive: true, force: true });
    await rename(displacedWorktreePath, linked);
    assert.equal((await worktrees.revalidate(workspace.id)).status, "verified");

    await worktrees.updateWorkspace({ operation: "archive", workspaceId: workspace.id });
    const archivedRead = await restartedHierarchy.hierarchy.read();
    assert.equal(
      archivedRead?.records.length,
      4,
      "archived managed owners remain visible as history",
    );
    assert.ok(
      archivedRead?.records
        .filter((record) => record.nativeSessionId !== "legacy-sidecar-session")
        .every((record) => record.status === "pending-verification"),
      "archived owners are not current execution associations",
    );
    assert.ok(
      archivedRead?.records
        .filter((record) => record.nativeSessionId !== "legacy-sidecar-session")
        .every(
          (record) =>
            record.pendingReason === "workspace-archived" &&
            record.ownerAssociation === undefined &&
            record.ownerHistoryAssociation?.worktreeGeneration === generation,
        ),
      "archived history keeps its original association without an execution association",
    );
    await assert.rejects(
      restartedHost.createWorkspaceSession(request("archived-session", "zcode", nativeBinding)),
      /stale-or-unavailable-workspace/,
    );
    await worktrees.updateWorkspace({ operation: "unarchive", workspaceId: workspace.id });

    const missingWorktreePath = join(root, "temporarily-missing-worktree");
    await rename(linked, missingWorktreePath);
    assert.equal((await worktrees.revalidate(workspace.id)).status, "missing");
    const missingRead = await restartedHierarchy.hierarchy.read();
    assert.equal(missingRead?.records.length, 4);
    assert.ok(
      missingRead?.records
        .filter((record) => record.nativeSessionId !== "legacy-sidecar-session")
        .every(
          (record) =>
            record.pendingReason === "missing" &&
            record.workspacePath === linked &&
            record.ownerHistoryAssociation?.worktreeGeneration === generation,
        ),
      "missing worktree history keeps its original path and generation",
    );
    await rename(missingWorktreePath, linked);
    assert.equal((await worktrees.revalidate(workspace.id)).status, "verified");

    await git(repo, ["worktree", "remove", "--force", linked]);
    await git(repo, ["worktree", "add", "-q", "-b", "session-test-rebuilt", linked]);
    const unacceptedRebuild = await worktrees.revalidate(workspace.id);
    assert.equal(unacceptedRebuild.status, "needsVerification");
    const acceptedRebuild = await worktrees.revalidate(workspace.id, { acceptRebuild: true });
    assert.equal(acceptedRebuild.status, "verified");
    assert.notEqual(acceptedRebuild.workspace.worktreeGeneration, generation);
    await assert.rejects(
      restartedHost.createWorkspaceSession(nativeRequest),
      /stale-or-unavailable-workspace/,
    );

    await restartedHost.close();
    restartedHost = undefined;
    nativeOwner.close();
    nativeOwner = createSqliteNativeOwner(join(root, "native-sessions.sqlite"));
    restartedHost = createHost(restartedRegistry);
    const rebuiltHierarchy = createHierarchy(restartedHost, join(root, "hierarchy-sidecar.json"));
    const rebuiltRead = await rebuiltHierarchy.hierarchy.read();
    assert.equal(rebuiltRead?.records.length, 4);
    assert.ok(
      rebuiltRead?.records
        .filter((record) => record.nativeSessionId !== "legacy-sidecar-session")
        .every(
          (record) =>
            record.status === "pending-verification" &&
            record.pendingReason === "stale-generation" &&
            record.workspacePath === linked &&
            record.ownerHistoryAssociation?.worktreeGeneration === generation &&
            record.ownerAssociation === undefined,
        ),
      "restart discovers original owners without rebinding them to the rebuilt generation",
    );

    const removal = await worktrees.previewRemoveWorkspace({
      workspaceId: workspace.id,
      expectedGeneration: acceptedRebuild.workspace.worktreeGeneration,
    });
    assert.equal(removal.safeToRemove, true);
    assert.ok(removal.confirmationToken);
    await worktrees.removeWorkspace({
      workspaceId: workspace.id,
      expectedGeneration: acceptedRebuild.workspace.worktreeGeneration,
      confirmationToken: removal.confirmationToken!,
    });
    const removedRead = await rebuiltHierarchy.hierarchy.read();
    assert.equal(removedRead?.records.length, 4);
    assert.ok(
      removedRead?.records
        .filter((record) => record.nativeSessionId !== "legacy-sidecar-session")
        .every(
          (record) =>
            record.pendingReason === "workspace-removed" && record.workspacePath === linked,
        ),
      "removed worktree history remains readable",
    );
    assert.equal(
      removedRead?.records.find((record) => record.nativeSessionId === "legacy-sidecar-session")
        ?.ownerHistoryAssociation,
      undefined,
      "an old mapping is not upgraded to the rebuilt generation",
    );
    await assert.rejects(
      restartedHost.createWorkspaceSession(nativeRequest),
      /stale-or-unavailable-workspace/,
    );
    assert.equal(testPi.modelCalls, 0);
  } finally {
    await firstHost?.close().catch(() => undefined);
    await restartedHost?.close().catch(() => undefined);
    nativeOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace session creation, receipt retry, and current read preserve a whitespace Git path", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-workspace-session-path-identity-"));
  const repo = join(root, "repo");
  const linked = join(root, "linked worktree \n");
  const trimmedNeighbor = join(root, "linked worktree");
  const targetRoot = join(root, "agent-host");
  const admissionRoot = join(root, "admission");
  const target = {
    id: targetId,
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const admission = createNodeWorkspaceAdmissionController({
    root: admissionRoot,
    targetId: () => targetId,
  });
  const worktrees = createFileWorktreeService({
    filePath: join(root, "worktrees.json"),
    admissionRoot,
    admissionController: admission,
    targetId: () => targetId,
  });
  let nativeOwner = createSqliteNativeOwner(join(root, "native-sessions.sqlite"));
  let host: AgentHostTargetService | undefined;
  try {
    await git(undefined, ["init", "-q", repo]);
    await git(repo, ["config", "user.email", "test@example.com"]);
    await git(repo, ["config", "user.name", "Workspace Path Test"]);
    await writeFile(join(repo, "README.md"), "fixture only\n", "utf8");
    await git(repo, ["add", "README.md"]);
    await git(repo, ["commit", "-qm", "initial"]);
    await git(repo, ["worktree", "add", "-q", "-b", "whitespace-path", linked]);
    await git(repo, ["worktree", "add", "-q", "-b", "trimmed-neighbor", trimmedNeighbor]);
    const discovery = await worktrees.discover(linked);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") throw new Error("whitespace worktree discovery failed");
    const candidate = discovery.candidates.find((item) => item.worktreePath === linked);
    assert.ok(candidate);
    const workspace = (await worktrees.adopt("project-path-identity", candidate)).workspace;
    assert.equal(workspace.worktreePath, linked);
    assert.equal(workspace.workspaceIdentity, undefined);

    const pi = new NoCostPi();
    const registry = new HarnessRegistry();
    registry.register(pi);
    host = createAgentHostTarget({
      root: targetRoot,
      target,
      registry,
      worktrees,
      admission,
      nativeOwner: nativeOwner.port,
    });
    const nativeRequest: WorkspaceSessionCreateRequest = {
      requestId: "whitespace-native",
      workspaceId: workspace.id,
      worktreeGeneration: workspace.worktreeGeneration,
      harnessId: "zcode",
      modelBinding: {
        kind: "native-selection",
        selection: { providerId: "provider-native", modelId: "model-native" },
      },
    };
    const piRequest: WorkspaceSessionCreateRequest = {
      requestId: "whitespace-pi",
      workspaceId: workspace.id,
      worktreeGeneration: workspace.worktreeGeneration,
      harnessId: "pi",
      modelBinding: {
        kind: "host-managed",
        selection: { providerId: "provider-pi", modelId: "model-pi" },
      },
    };
    const nativeCreated = await host.createWorkspaceSession(nativeRequest);
    const piCreated = await host.createWorkspaceSession(piRequest);
    assert.equal(nativeCreated.locator.workspacePath, linked);
    assert.equal(nativeCreated.locator.workspaceIdentity, undefined);
    assert.equal(piCreated.locator.workspacePath, linked);
    assert.equal(piCreated.locator.workspaceIdentity, undefined);
    assert.equal(pi.creates, 1);
    assert.equal(pi.modelCalls, 0);

    await host.close();
    host = undefined;
    nativeOwner.close();
    nativeOwner = createSqliteNativeOwner(join(root, "native-sessions.sqlite"));
    host = createAgentHostTarget({
      root: targetRoot,
      target,
      registry,
      worktrees,
      admission,
      nativeOwner: nativeOwner.port,
    });
    assert.equal(
      (await host.createWorkspaceSession(nativeRequest)).locator.sessionId,
      nativeCreated.locator.sessionId,
      "native receipt retry keeps the original owner ID",
    );
    assert.equal(
      (await host.createWorkspaceSession(piRequest)).locator.sessionId,
      piCreated.locator.sessionId,
      "Pi manifest retry keeps the original owner ID",
    );

    const hierarchy = createSessionHierarchyService({
      index: {
        async listPersistedSessionLocators() {
          return [];
        },
      },
      currentOwners: createCurrentOwnerSessionSource(host),
      worktrees: {
        async read() {
          const current = await worktrees.read();
          return {
            workspaces: current.workspaces.map((item) => ({
              targetId,
              projectId: item.projectId,
              workspaceId: item.id,
              worktreePath: item.worktreePath,
              worktreeGeneration: item.worktreeGeneration,
              ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
              lifecycle: item.lifecycle,
              verification: item.verification,
            })),
          };
        },
      },
      persistence: createSessionHierarchyFilePersistence(join(root, "hierarchy.json")),
      targetId: () => targetId,
      knownHarnessIds: ["zcode", "pi"],
    });
    const current = await hierarchy.read();
    assert.equal(current?.records.length, 2);
    assert.deepEqual(
      current?.records.map((record) => record.workspacePath),
      [linked, linked],
      "current membership retains the exact Git path instead of aliasing its trimmed neighbor",
    );
    assert.ok(current?.records.every((record) => record.workspaceIdentity === undefined));
    assert.equal(pi.creates, 1, "current read and retries never attach or recreate Pi");
    assert.equal(pi.attaches, 0);
    assert.equal(pi.modelCalls, 0);
  } finally {
    await host?.close().catch(() => undefined);
    nativeOwner.close();
    await rm(root, { recursive: true, force: true });
  }
});
