import assert from "node:assert/strict";
import test from "node:test";
import {
  agentCommandSchema,
  agentEventSchema,
  assertUniqueHostSessionIds,
  backendBindingSchema,
  buildSessionSpecV2,
  capabilityReportSchema,
  harnessPluginManifestSchema,
  hostSessionCacheKey,
  parseCompatibleSessionSpec,
  parseHierarchySnapshot,
  resolveSessionOwnership,
  sessionSpecSchema,
  sessionSpecV2Schema,
  type AgentSession,
  type HierarchySnapshot,
} from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { loadExplicitHarnessPlugins } from "../src/agent-host/harnessPluginLoader.js";
import { MockHarness } from "../src/agent-adapters/mock/mockHarness.js";

const modelBinding = {
  kind: "host-managed" as const,
  selection: { providerId: "provider-a", modelId: "model-a" },
};

function workspace(id: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    id,
    projectId: "project-one",
    repositoryBindingId: "binding-local",
    title: id,
    worktreePath: `/repo/${id}`,
    worktreeGeneration: `generation-${id}`,
    isMainWorktree: id === "workspace-main",
    head: { kind: "branch" as const, ref: "main", oid: null },
    origin: "adopted" as const,
    lifecycle: "active" as const,
    verification: "verified" as const,
    ...overrides,
  };
}

function session(id: string, workspaceId: string): AgentSession {
  return {
    schemaVersion: 1,
    id,
    workspaceId,
    harnessId: "mock",
    title: id,
    modelBinding,
  };
}

function snapshot(
  sessions: AgentSession[],
  workspaces = [workspace("workspace-main")],
): HierarchySnapshot {
  return parseHierarchySnapshot({
    schemaVersion: 1,
    projects: [
      {
        schemaVersion: 1,
        id: "project-one",
        name: "Project One",
        defaultWorkspaceId: "workspace-main",
      },
    ],
    bindings: [
      {
        schemaVersion: 1,
        id: "binding-local",
        projectId: "project-one",
        executionTargetId: "target-local",
        gitCommonDir: "/repo/.git",
      },
    ],
    workspaces,
    sessions,
  });
}

test("v1 session specs stay readable and v2 uses the plan field names", () => {
  const v1 = {
    schemaVersion: 1 as const,
    hostSessionId: "host-1",
    execution: { targetId: "local-1", workspaceIdentity: "workspace-1", worktreePath: "/tmp/demo" },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding,
  };
  assert.equal(sessionSpecSchema.safeParse(v1).success, true);
  assert.equal(parseCompatibleSessionSpec(v1).schemaVersion, 1);
  assert.equal(sessionSpecV2Schema.safeParse({ ...v1, schemaVersion: 2 }).success, false);

  const hierarchy = snapshot([
    session("host-1", "workspace-main"),
    session("host-2", "workspace-main"),
  ]);
  const first = buildSessionSpecV2({
    ...resolveSessionOwnership(hierarchy, "host-1"),
    adapterVersion: "1.0.0",
    modelBinding,
  });
  const second = buildSessionSpecV2({
    ...resolveSessionOwnership(hierarchy, "host-2"),
    adapterVersion: "1.0.0",
    modelBinding,
    cwdRelativeToWorktree: "src",
  });
  assert.equal(first.schemaVersion, 2);
  assert.equal(first.hostSessionId, "host-1");
  assert.equal(first.projectId, "project-one");
  assert.equal(first.workspaceId, "workspace-main");
  assert.equal(first.execution.targetId, "target-local");
  assert.equal(first.execution.cwdRelativeToWorktree, ".");
  assert.equal(second.execution.cwdRelativeToWorktree, "src");
  assert.equal(first.harness.id, second.harness.id);
  assert.notEqual(hostSessionCacheKey(first), hostSessionCacheKey(second));
  assert.doesNotThrow(() => assertUniqueHostSessionIds([first, second]));
  assert.throws(() => assertUniqueHostSessionIds([first, first]), /duplicate-id:host-1/);

  const roundTrip = sessionSpecV2Schema.parse(JSON.parse(JSON.stringify(first)));
  assert.deepEqual(roundTrip, first);
  assert.equal(sessionSpecV2Schema.safeParse({ ...first, secret: "never" }).success, false);
  assert.equal(
    sessionSpecV2Schema.safeParse({
      ...first,
      execution: { ...first.execution, cwdRelativeToWorktree: "../outside" },
    }).success,
    false,
  );
});

test("ownership rejects a workspace that still needs verification", () => {
  const hierarchy = snapshot(
    [session("host-1", "workspace-main")],
    [workspace("workspace-main", { verification: "needsVerification" })],
  );
  assert.throws(
    () =>
      buildSessionSpecV2({
        ...resolveSessionOwnership(hierarchy, "host-1"),
        adapterVersion: "1.0.0",
        modelBinding,
      }),
    /workspace-not-admissible/,
  );
});

test("commands, events, bindings and capability reports keep plan names", () => {
  for (const support of ["supported", "unsupported", "experimental", "unknown"] as const) {
    const report = { support, ...(support === "supported" ? {} : { reason: "explained" }) };
    assert.equal(capabilityReportSchema.safeParse(report).success, true);
  }
  assert.equal(capabilityReportSchema.safeParse({ support: "unknown" }).success, false);
  assert.equal(
    backendBindingSchema.safeParse({
      hostSessionId: "host-1",
      backendSessionId: "native-1",
      backendVersion: "1.0.0",
      runtimeEpoch: "epoch-1",
    }).success,
    true,
  );
  assert.equal(
    agentCommandSchema.safeParse({ type: "detach", commandId: "c1", hostSessionId: "host-1" })
      .success,
    true,
  );
  assert.equal(
    agentCommandSchema.safeParse({
      type: "viewHistory",
      commandId: "c2",
      hostSessionId: "host-1",
    }).success,
    true,
  );
  assert.equal(
    agentEventSchema.safeParse({
      kind: "turn.started",
      hostSessionId: "host-1",
      runtimeEpoch: "epoch-1",
      sequence: 1,
      eventId: "event-1",
      at: 1,
      turnId: "turn-1",
    }).success,
    true,
  );
  assert.equal(
    harnessPluginManifestSchema.safeParse({
      id: "mock",
      name: "Mock",
      adapterVersion: "1.0.0",
      trusted: true,
    }).success,
    false,
  );
});

test("plugin loader skips untrusted and disabled factories and the registry rejects unknowns", () => {
  const registry = new HarnessRegistry();
  let created = 0;
  const manifest = { id: "mock", name: "Mock", adapterVersion: "1.0.0" };
  const plugin = {
    manifest,
    trusted: false,
    create: () => {
      created += 1;
      return new MockHarness();
    },
  };
  const untrusted = loadExplicitHarnessPlugins(registry, [plugin], new Set(["mock"]));
  assert.deepEqual(untrusted.skipped, [{ id: "mock", reason: "untrusted" }]);
  assert.equal(created, 0);
  assert.throws(() => registry.require("mock"), /unknown harness/);

  const disabled = loadExplicitHarnessPlugins(registry, [{ ...plugin, trusted: true }], new Set());
  assert.deepEqual(disabled.skipped, [{ id: "mock", reason: "disabled" }]);
  assert.equal(created, 0);

  const loaded = loadExplicitHarnessPlugins(
    registry,
    [{ ...plugin, trusted: true }],
    new Set(["mock"]),
  );
  assert.deepEqual(loaded.loaded, ["mock"]);
  assert.equal(created, 1);
  assert.equal(registry.require("mock").id, "mock");
  assert.throws(() => registry.register(new MockHarness()), /duplicate/i);
});

test("mock reports text, tools and approval without a duplicate host session", async () => {
  const mock = new MockHarness({ textChunks: ["one"] });
  const capabilities = await mock.capabilities({
    id: "target-local",
    kind: "local",
    platform: "linux",
    available: true,
  });
  assert.equal(capabilities.text.support, "supported");
  assert.equal(capabilities.tools.support, "supported");
  assert.equal(capabilities.images.support, "unsupported");
  assert.equal(capabilities.hostManagedModel?.support, "experimental");
  assert.match(capabilities.hostManagedModel?.reason ?? "", /provider/);
  const events: { kind: string; sequence?: number }[] = [];
  mock.subscribe("host-1", (event) => events.push(event));
  await mock.create({
    schemaVersion: 1,
    hostSessionId: "host-1",
    execution: {
      targetId: "target-local",
      workspaceIdentity: "workspace-main",
      worktreePath: "/repo",
    },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding,
  });
  await assert.rejects(
    mock.create({
      schemaVersion: 1,
      hostSessionId: "host-1",
      execution: {
        targetId: "target-local",
        workspaceIdentity: "workspace-main",
        worktreePath: "/repo",
      },
      harness: { id: "mock", adapterVersion: "1.0.0" },
      modelBinding,
    }),
    /duplicate-id/,
  );
  const pending = mock.send({
    type: "send",
    commandId: "send-1",
    hostSessionId: "host-1",
    turnId: "turn-1",
    text: "edit",
  });
  await mock.waitForInteraction("host-1");
  assert.equal(
    events.some((event) => event.kind === "interaction.requested"),
    true,
  );
  await mock.resolveInteraction({
    type: "resolveInteraction",
    commandId: "allow-1",
    hostSessionId: "host-1",
    runtimeEpoch: mock.epoch("host-1"),
    turnId: "turn-1",
    interactionId: "approval-1",
    decision: "allow",
  });
  await pending;
  assert.equal(
    events.some((event) => event.kind === "tool.finished"),
    true,
  );
  const before = events.length;
  mock.emitDuplicate("host-1");
  assert.equal(events.length, before + 1);
  assert.equal(events.at(-1)?.sequence, events.at(-2)?.sequence);
});
