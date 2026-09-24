import assert from "node:assert/strict";
import test from "node:test";
import {
  backendBindingV2Schema,
  capabilityReportSchema,
  cwdRelativeToWorktreeSchema,
  deriveWritableSessionSpec,
  frozenTurnModelRouteSchema,
  readableSessionSpecSchema,
  writableSessionSpecV2Schema,
  legacySessionSpecSchema,
  harnessManifestSchema,
  harnessCatalogEntrySchema,
} from "@zcode/shared/agent-host";
import { parseSidebarSnapshot } from "@zcode/shared/project-workspaces";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { hierarchyFixture } from "./fixtures/hierarchy.js";

const binding = hierarchyFixture.bindings[0]!;
const workspace = hierarchyFixture.workspaces[0]!;
const input = {
  hostSessionId: "new-id",
  projectId: "p1",
  workspaceId: "w1",
  binding,
  workspace,
  expectedTargetId: "local",
  expectedGeneration: workspace.worktreeGeneration,
  harness: { id: "mock", adapterVersion: "1.0.0" },
  modelBinding: {
    kind: "host-managed" as const,
    selection: { providerId: "provider-a", modelId: "model-a" },
  },
};

test("v2 serialization, legacy read separation and safe cwd", () => {
  const spec = deriveWritableSessionSpec({ ...input, cwdRelativeToWorktree: "src/lib" });
  assert.deepEqual(writableSessionSpecV2Schema.parse(JSON.parse(JSON.stringify(spec))), spec);
  assert.equal(readableSessionSpecSchema.parse(spec).schemaVersion, 2);
  assert.equal(
    backendBindingV2Schema.safeParse({
      schemaVersion: 2,
      hostSessionId: spec.hostSessionId,
      backendSessionId: "native-1",
      backendVersion: "1.0.0",
      runtimeEpoch: "epoch-1",
      targetId: "local",
      workspaceId: "w1",
      worktreeGeneration: workspace.worktreeGeneration,
      harnessId: "mock",
    }).success,
    true,
  );
  assert.equal(
    backendBindingV2Schema.safeParse({
      hostSessionId: spec.hostSessionId,
      backendSessionId: "native-1",
      backendVersion: "1.0.0",
      runtimeEpoch: "epoch-1",
    }).success,
    false,
  );
  for (const support of ["unsupported", "unknown", "experimental"])
    assert.equal(capabilityReportSchema.safeParse({ support }).success, false);
  assert.equal(legacySessionSpecSchema.safeParse(spec).success, false);
  assert.equal(writableSessionSpecV2Schema.safeParse({ ...spec, schemaVersion: 1 }).success, false);
  assert.equal(
    writableSessionSpecV2Schema.safeParse({
      ...spec,
      execution: { ...spec.execution, worktreeGeneration: undefined },
    }).success,
    false,
  );
  for (const cwd of ["", "/tmp", "../x", "a/../b", "a//b", "a/./b", "C:\\x", "a\\b", "a\0b"])
    assert.equal(cwdRelativeToWorktreeSchema.safeParse(cwd).success, false, cwd);
  assert.equal(deriveWritableSessionSpec(input).execution.cwdRelativeToWorktree, ".");
});

test("target-derived identity refuses wrong project, binding, target, generation and inactive worktree", () => {
  for (const changed of [
    { ...input, projectId: "p2" },
    { ...input, workspaceId: "w2" },
    { ...input, expectedTargetId: "ssh-a" },
    { ...input, expectedGeneration: "recreated" },
    { ...input, workspace: { ...workspace, lifecycle: "needsVerification" as const } },
    { ...input, binding: hierarchyFixture.bindings[1]! },
  ])
    assert.throws(() => deriveWritableSessionSpec(changed));
});

test("hierarchy fixture retains duplicate harness sessions but rejects duplicate record IDs and wrong ownership", () => {
  assert.equal(hierarchyFixture.projects.length, 2);
  assert.equal(hierarchyFixture.workspaces.length, 4);
  assert.deepEqual(
    hierarchyFixture.sessions.map(({ session }) => session.harnessId),
    ["pi", "pi", "zcode"],
  );
  assert.throws(
    () =>
      parseSidebarSnapshot({
        ...hierarchyFixture,
        sessions: [...hierarchyFixture.sessions, hierarchyFixture.sessions[0]],
      }),
    /duplicate-id/,
  );
  assert.throws(
    () =>
      parseSidebarSnapshot({
        ...hierarchyFixture,
        sessions: [
          {
            ...hierarchyFixture.sessions[0],
            session: { ...hierarchyFixture.sessions[0]!.session, projectId: "p2" },
          },
          ...hierarchyFixture.sessions.slice(1),
        ],
      }),
    /invalid-ownership/,
  );
});

test("hidden workspace still contributes stable project attention and offline freshness is independent", () => {
  assert.equal(workspace.hidden, true);
  assert.deepEqual(hierarchyFixture.projectSummaries[0]?.attentionSessionIds, ["s1"]);
  assert.equal(hierarchyFixture.workspaceSummaries[0]?.totalAgents, 3);
  assert.equal(hierarchyFixture.workspaceSummaries[2]?.freshness, "offline");
  assert.deepEqual(
    hierarchyFixture.sessions.map(({ session }) => session.sortOrder),
    [0, 1, 2],
  );
  assert.throws(
    () =>
      parseSidebarSnapshot({
        ...hierarchyFixture,
        workspaceSummaries: hierarchyFixture.workspaceSummaries.map((s) =>
          s.workspaceId === "w1" ? { ...s, totalAgents: 0 } : s,
        ),
      }),
    /invalid-summary-count/,
  );
  assert.throws(
    () =>
      parseSidebarSnapshot({
        ...hierarchyFixture,
        projectSummaries: hierarchyFixture.projectSummaries.map((s) =>
          s.projectId === "p1" ? { ...s, attentionSessionIds: [] } : s,
        ),
      }),
    /invalid-summary-count/,
  );
  assert.throws(
    () =>
      parseSidebarSnapshot({
        ...hierarchyFixture,
        workspaceSummaries: hierarchyFixture.workspaceSummaries.slice(1),
      }),
    /invalid-summary-identity/,
  );
});

test("per-turn binding retains selected route and rejects silent native fallback", () => {
  const route = {
    schemaVersion: 1,
    hostSessionId: "s1",
    turnId: "turn-1",
    runtimeEpoch: "epoch-1",
    targetId: "local",
    workspaceId: "w1",
    harnessId: "pi",
    adapterVersion: "1.0.0",
    catalogFingerprint: "catalog-1",
    requested: input.modelBinding,
    effective: input.modelBinding.selection,
    route: "pi-sdk",
  } as const;
  assert.deepEqual(frozenTurnModelRouteSchema.parse(JSON.parse(JSON.stringify(route))), route);
  assert.equal(
    frozenTurnModelRouteSchema.safeParse({ ...route, effective: undefined }).success,
    false,
  );
  assert.equal(
    frozenTurnModelRouteSchema.safeParse({
      ...route,
      effective: { providerId: "provider-b", modelId: "model-b" },
    }).success,
    false,
  );
  assert.equal(
    frozenTurnModelRouteSchema.safeParse({ ...route, route: "harness-managed" }).success,
    false,
  );
  assert.equal(
    frozenTurnModelRouteSchema.safeParse({ ...route, credentialRef: "ref", token: "secret" })
      .success,
    false,
  );
});

test("trusted factory, unknown harness and unsafe icon IDs", () => {
  const registry = new HarnessRegistry();
  const manifest = {
    schemaVersion: 1 as const,
    id: "mock",
    name: "Mock",
    adapterVersion: "1.0.0",
    icon: { light: "builtin:mock" },
  };
  registry.registerTrusted(manifest, () => new MockHarness());
  assert.equal(
    harnessCatalogEntrySchema.safeParse({ manifest, availability: "unknown" }).success,
    false,
  );
  assert.equal(
    harnessCatalogEntrySchema.safeParse({
      manifest,
      availability: "unknown",
      reason: "target not probed",
    }).success,
    true,
  );
  assert.deepEqual(registry.manifest("mock"), manifest);
  assert.throws(() => registry.require("missing"), /unknown harness/);
  assert.throws(() => registry.registerTrusted(manifest, () => new MockHarness()), /duplicate-id/);
  assert.throws(
    () =>
      new HarnessRegistry().registerTrusted(
        { ...manifest, adapterVersion: "wrong" },
        () => new MockHarness(),
      ),
    /mismatch/,
  );
  for (const icon of [
    "https://evil/icon.svg",
    "../icon.svg",
    "/absolute.svg",
    "data:image/svg+xml,hi",
    "builtin:<script>",
  ]) {
    assert.equal(
      harnessManifestSchema.safeParse({ ...manifest, icon: { light: icon } }).success,
      false,
    );
  }
});

test("mock deterministic duplicate/gap/crash event identities", async () => {
  const mock = new MockHarness({
    gapBeforeText: true,
    duplicateAfterText: true,
    crashAfterText: true,
    textChunks: ["a", "b"],
  });
  const events: { sequence: number; eventId: string; kind: string }[] = [];
  mock.subscribe("new-id", (event) => events.push(event));
  await mock.create(deriveWritableSessionSpec(input));
  await mock.send({
    type: "send",
    commandId: "c",
    hostSessionId: "new-id",
    turnId: "t",
    text: "hello",
  });
  assert.deepEqual(
    events.map((event) => event.kind),
    [
      "turn.started",
      "text.delta",
      "text.delta",
      "message.finished",
      "message.finished",
      "session.error",
      "turn.finished",
    ],
  );
  assert.equal(events[1]!.sequence, 3);
  assert.equal(events[3]!.eventId, events[4]!.eventId);
  assert.equal(events[0]!.eventId, "mock-epoch-1-event-1");
});
