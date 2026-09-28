import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertUniqueHostSessionIds } from "@zcode/shared/agent-host";
import { ZCodeHarnessAdapter } from "../src/agent-adapters/zcode/zcodeHarnessAdapter.js";
import type { NativeV4CommandPort } from "../src/agent-adapters/zcode/zcodeHarnessAdapter.js";
import { CommandJournal } from "../src/agent-host/commandJournal.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import {
  indexHostSessions,
  readLegacyZCodeSession,
  SessionRouter,
  type WorkspaceExecutionLocation,
  type WorkspaceSessionOwnership,
  type WorkspaceSessionRecord,
} from "../src/agent-host/sessionRouter.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

test("legacy ZCode sessions read as harness zcode without inventing glm", () => {
  const missingProvider = readLegacyZCodeSession({
    taskId: "legacy-1",
    workspacePath: "/repo/main",
  });
  assert.equal(missingProvider.kind, "native");
  if (missingProvider.kind !== "native") return;
  assert.equal(missingProvider.harnessId, "zcode");
  assert.equal(missingProvider.hostSessionId, "legacy-1");
  assert.equal("provider" in missingProvider, false);

  const explicitGlm = readLegacyZCodeSession({
    sessionId: "legacy-2",
    taskId: "legacy-2",
    provider: "glm",
    workspaceId: "workspace-main",
  });
  assert.deepEqual(explicitGlm, {
    kind: "native",
    harnessId: "zcode",
    hostSessionId: "legacy-2",
    provider: "glm",
    workspaceId: "workspace-main",
  });

  const sidecar = readLegacyZCodeSession({
    sessionId: "legacy-3",
    agentHost: {
      schemaVersion: 1,
      harnessId: "zcode",
      targetId: "local-1",
      hostSessionId: "legacy-3",
      modelBindingKind: "host-managed",
    },
  });
  assert.equal(sidecar.kind, "native");
  if (sidecar.kind !== "native") return;
  assert.equal(sidecar.harnessId, "zcode");
});

test("unknown backends stay unresolved and are not rewritten to glm or zcode", () => {
  const unknownProvider = readLegacyZCodeSession({
    sessionId: "external-provider",
    provider: "acme",
    workspacePath: "/repo/main",
  });
  assert.equal(unknownProvider.kind, "unresolved");
  if (unknownProvider.kind !== "unresolved") return;
  assert.equal(unknownProvider.reason, "unknown-backend");
  assert.equal(unknownProvider.provider, "acme");
  assert.equal("harnessId" in unknownProvider, false);

  const glmAsHarness = readLegacyZCodeSession({
    sessionId: "mislabeled",
    harnessId: "glm",
    workspacePath: "/repo/main",
  });
  assert.equal(glmAsHarness.kind, "unresolved");
  if (glmAsHarness.kind !== "unresolved") return;
  assert.equal(glmAsHarness.reason, "unknown-backend");
  assert.equal(glmAsHarness.harnessId, "glm");
  assert.equal("provider" in glmAsHarness, false);

  const imported = readLegacyZCodeSession({
    taskId: "claude-import",
    provider: "glm",
    migrationSource: "claudeCode",
    workspacePath: "/repo/main",
  });
  assert.equal(imported.kind, "unresolved");
  if (imported.kind !== "unresolved") return;
  assert.equal(imported.reason, "imported-history");
  assert.equal(imported.provider, "glm");
  assert.equal("harnessId" in imported, false);
});

test("another session reuses the adopted worktree and deletion rejects admission", async () => {
  const ownership = fakeWorkspaces();
  const registry = new HarnessRegistry();
  registry.register(new MockHarness());
  const router = new SessionRouter(registry, { allowExternalAdmission: true }, ownership);
  const first = await router.openWorkspaceSession({
    workspaceId: "workspace-main",
    harnessId: "zcode",
    title: "One",
  });
  const second = await router.openWorkspaceSession({
    workspaceId: "workspace-main",
    harnessId: "zcode",
    title: "Two",
  });
  assert.equal(first.kind, "native");
  assert.equal(second.kind, "native");
  assert.notEqual(first.session.id, second.session.id);
  assert.equal(first.execution.worktreePath, "/repo/main");
  assert.equal(second.execution.worktreePath, first.execution.worktreePath);
  assert.equal(second.execution.worktreeGeneration, first.execution.worktreeGeneration);
  assert.equal(ownership.worktreeCreates, 0);
  assert.equal(ownership.discoveries, 0);
  const grouped = await router.listWorkspaceSessions("workspace-main");
  assert.deepEqual(
    grouped.get("workspace-main\0zcode")?.map((session) => session.hostSessionId),
    ["legacy-1", first.session.id, second.session.id],
  );

  const located = await router.locateLegacySession({
    taskId: "legacy-1",
    workspacePath: "/repo/main",
  });
  assert.equal(located.read.kind, "native");
  assert.equal(located.execution?.workspaceId, "workspace-main");
  assert.equal(located.execution?.worktreePath, "/repo/main");

  await assert.rejects(
    router.openWorkspaceSession({
      workspaceId: "workspace-deleting",
      harnessId: "zcode",
      title: "Blocked",
    }),
    /deletion-admission-rejected/,
  );
  assert.equal(
    ownership.sessions.some((session) => session.workspaceId === "workspace-deleting"),
    false,
  );
});

test("one workspace and harness can own many host sessions", () => {
  const sessions = [
    { hostSessionId: "host-a", workspaceId: "workspace-main", harnessId: "zcode" },
    { hostSessionId: "host-b", workspaceId: "workspace-main", harnessId: "zcode" },
    { hostSessionId: "host-c", workspaceId: "workspace-main", harnessId: "mock" },
  ];
  assert.doesNotThrow(() => assertUniqueHostSessionIds(sessions));
  const grouped = indexHostSessions(sessions);
  assert.deepEqual(
    grouped.get("workspace-main\0zcode")?.map((session) => session.hostSessionId),
    ["host-a", "host-b"],
  );
  assert.throws(
    () =>
      indexHostSessions([
        sessions[0]!,
        { hostSessionId: "host-a", workspaceId: "workspace-other", harnessId: "zcode" },
      ]),
    /duplicate-id:host-a/,
  );
});

test("router keeps native zcode on V4 and does not admit it as an external owner", () => {
  const registry = new HarnessRegistry();
  registry.register(new ZCodeHarnessAdapter(unusedPort()));
  const router = new SessionRouter(registry, { allowExternalAdmission: true });
  assert.deepEqual(router.resolve({ sessionId: "old-session" }, "local-1"), { kind: "native" });
  assert.deepEqual(
    router.resolve(
      {
        sessionId: "native-meta",
        agentHost: {
          schemaVersion: 1,
          harnessId: "zcode",
          targetId: "local-1",
          hostSessionId: "native-meta",
          modelBindingKind: "host-managed",
        },
      },
      "local-1",
    ),
    { kind: "native" },
  );
  assert.throws(() => router.assertCanCreate("zcode"), /existing V4/);
  assert.throws(
    () =>
      router.resolve(
        {
          sessionId: "missing",
          agentHost: {
            schemaVersion: 1,
            harnessId: "acme",
            targetId: "local-1",
            hostSessionId: "missing",
            modelBindingKind: "host-managed",
          },
        },
        "local-1",
      ),
    /unknown harness/,
  );

  const closed = new SessionRouter(registry, { allowExternalAdmission: false });
  assert.throws(() => closed.assertCanCreate("mock"), /disabled/);
});

test("native facade persists a command before dispatch and reconnect does not resend", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-native-facade-"));
  try {
    const identity = {
      targetId: "local-1",
      workspaceIdentity: "workspace-main",
      harnessId: "zcode",
      hostSessionId: "host-a",
      runtimeEpoch: "v4-epoch",
    };
    let journal = await CommandJournal.open(root, identity);
    const calls: string[] = [];
    const port: NativeV4CommandPort = {
      async query(_hostSessionId, commandId) {
        calls.push("query");
        return journal.query(commandId);
      },
      async admit(command) {
        calls.push("admit");
        return journal.accept(command);
      },
      async dispatch() {
        calls.push("dispatch");
      },
    };
    const adapter = new ZCodeHarnessAdapter(port);
    const send = {
      type: "send" as const,
      commandId: "cmd-1",
      hostSessionId: "host-a",
      turnId: "turn-1",
      text: "edit the file",
    };
    assert.equal((await adapter.dispatchNative(send)).status, "accepted");
    assert.deepEqual(calls, ["query", "admit", "dispatch"]);
    calls.length = 0;
    assert.equal((await adapter.dispatchNative(send)).status, "duplicate");
    assert.deepEqual(calls, ["query"]);

    await journal.close();
    journal = await CommandJournal.open(root, identity);
    calls.length = 0;
    const replay = await adapter.reconnect("host-a", "cmd-1");
    assert.equal(replay?.status, "execution-unknown");
    assert.deepEqual(calls, ["query"]);
    assert.equal((await adapter.dispatchNative(send)).status, "execution-unknown");
    assert.deepEqual(calls, ["query", "query"]);
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native capabilities keep the shared report shape and echo the requested provider", async () => {
  const adapter = new ZCodeHarnessAdapter(unusedPort());
  const target = {
    id: "local-1",
    kind: "local" as const,
    platform: "linux" as const,
    available: true,
  };
  const capabilities = await adapter.capabilities(target);
  assert.equal(capabilities.text.support, "supported");
  assert.equal(capabilities.hostManagedModel?.support, "supported");
  assert.ok(capabilities.images.reason);
  const support = await adapter.hostManagedSupport(target, {
    providerId: "acme",
    modelId: "model-a",
  });
  assert.equal(support.support, "supported");
  assert.equal(support.constraints?.providerId, "acme");
  assert.equal(JSON.stringify(support).includes("glm"), false);
  assert.equal((await adapter.harnessManagedSupport?.(target))?.support, "unsupported");
});

test("SessionHost refuses zcode before writing a second session manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-refuse-"));
  try {
    const registry = new HarnessRegistry();
    const spec = {
      schemaVersion: 1 as const,
      hostSessionId: "host-a",
      execution: {
        targetId: "local-1",
        workspaceIdentity: "workspace-main",
        worktreePath: "/repo/main",
      },
      harness: { id: "zcode", adapterVersion: "native-v4" },
      modelBinding: {
        kind: "host-managed" as const,
        selection: { providerId: "acme", modelId: "model-a" },
      },
    };
    const target = {
      id: "local-1",
      kind: "local" as const,
      platform: "linux" as const,
      available: true,
    };
    const catalog = {
      fingerprint: "unused",
      validateSelection() {
        throw new Error("catalog must not be read");
      },
    };
    await assert.rejects(
      SessionHost.create({ root, spec, target, catalog, registry }),
      /existing V4/,
    );
    await assert.rejects(
      SessionHost.open({ root, spec, target, catalog, registry }),
      /existing V4/,
    );
    assert.deepEqual(await readdir(root).catch(() => []), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SessionHost refuses a workspace the worktree service marks as deleting", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-host-deleting-"));
  try {
    const registry = new HarnessRegistry();
    registry.register(new MockHarness());
    const ownership = fakeWorkspaces();
    ownership.sessions.push({
      id: "host-a",
      workspaceId: "workspace-main",
      harnessId: "mock",
      title: "Existing",
    });
    ownership.deleting.add("host-a");
    const spec = {
      schemaVersion: 1 as const,
      hostSessionId: "host-a",
      execution: {
        targetId: "local-1",
        workspaceIdentity: "workspace-main",
        worktreePath: "/repo/main",
        workspaceId: "workspace-main",
        worktreeGeneration: "gen-1",
      },
      harness: { id: "mock", adapterVersion: "1.0.0" },
      modelBinding: {
        kind: "host-managed" as const,
        selection: { providerId: "acme", modelId: "model-a" },
      },
    };
    const target = {
      id: "local-1",
      kind: "local" as const,
      platform: "linux" as const,
      available: true,
    };
    const catalog = {
      fingerprint: "unused",
      validateSelection() {
        throw new Error("catalog must not be read");
      },
    };
    await assert.rejects(
      SessionHost.create({ root, spec, target, catalog, registry, workspaces: ownership }),
      /deletion-admission-rejected/,
    );
    assert.deepEqual(await readdir(root), []);
    assert.equal(ownership.worktreeCreates, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeWorkspaces(): WorkspaceSessionOwnership & {
  sessions: WorkspaceSessionRecord[];
  deleting: Set<string>;
  worktreeCreates: number;
  discoveries: number;
} {
  const sessions: WorkspaceSessionRecord[] = [
    { id: "legacy-1", workspaceId: "workspace-main", harnessId: "zcode", title: "Legacy" },
  ];
  const execution: WorkspaceExecutionLocation = {
    executionTargetId: "local-1",
    workspaceId: "workspace-main",
    worktreePath: "/repo/main",
    worktreeGeneration: "gen-1",
    workspaceKey: "/repo/main",
    cwdRelativeToWorktree: ".",
    admissible: true,
  };
  let seq = 0;
  const ownership = {
    sessions,
    deleting: new Set<string>(),
    worktreeCreates: 0,
    discoveries: 0,
    async listSessions(workspaceId: string) {
      return sessions.filter((session) => session.workspaceId === workspaceId);
    },
    async readExecution(sessionId: string) {
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) throw new Error("unknown-session");
      if (ownership.deleting.has(sessionId)) {
        return {
          ...execution,
          workspaceId: session.workspaceId,
          admissible: false,
          reason: "deletion-admission-rejected",
        };
      }
      return { ...execution, workspaceId: session.workspaceId };
    },
    async createAgentSession(input: { workspaceId: string; harnessId: string; title: string }) {
      if (input.workspaceId === "workspace-deleting") {
        throw Object.assign(new Error("deletion-admission-rejected"), {
          code: "deletion-admission-rejected",
        });
      }
      const session = {
        id: `host-${++seq}`,
        workspaceId: input.workspaceId,
        harnessId: input.harnessId,
        title: input.title,
      };
      sessions.push(session);
      return { session, execution: { ...execution, workspaceId: input.workspaceId } };
    },
  };
  return ownership;
}

function unusedPort(): NativeV4CommandPort {
  return {
    async query() {
      throw new Error("query must not run");
    },
    async admit() {
      throw new Error("admit must not run");
    },
    async dispatch() {
      throw new Error("dispatch must not run");
    },
  };
}
