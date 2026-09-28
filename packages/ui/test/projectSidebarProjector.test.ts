import assert from "node:assert/strict";
import test from "node:test";
import { buildProjectSidebarViewModel } from "../src/project-sidebar/projector.js";
import {
  agentHostConversationOwnerKey,
  isValidAgentHostConversationOwner,
} from "../src/v4/agentHostConversationOwner.js";

function source() {
  const evidence = { canonicalPath: "/repo", device: 1, inode: 2, birthtimeMs: 3 };
  return {
    catalog: {
      schemaVersion: 1 as const,
      projects: [
        {
          schemaVersion: 1 as const,
          id: "project-one",
          name: "One",
          workspaceIds: ["main", "empty"],
          pinned: false,
          sortOrder: 0,
        },
        {
          schemaVersion: 1 as const,
          id: "project-two",
          name: "Two",
          workspaceIds: ["detached"],
          pinned: false,
          sortOrder: 1,
        },
      ],
    },
    worktrees: {
      schemaVersion: 1 as const,
      bindings: [
        {
          schemaVersion: 1 as const,
          id: "binding-one",
          projectId: "project-one",
          executionTargetId: "target",
          gitCommonDir: "/repo/.git",
          commonDirEvidence: evidence,
        },
        {
          schemaVersion: 1 as const,
          id: "binding-two",
          projectId: "project-two",
          executionTargetId: "target",
          gitCommonDir: "/repo-two/.git",
          commonDirEvidence: { ...evidence, canonicalPath: "/repo-two" },
        },
      ],
      workspaces: [
        {
          schemaVersion: 1 as const,
          id: "main",
          projectId: "project-one",
          repositoryBindingId: "binding-one",
          title: "Main",
          workspaceIdentity: "one-main",
          worktreePath: "/repo",
          worktreeGeneration: "gen-main",
          isMainWorktree: true,
          head: { kind: "branch" as const, ref: "main", oid: null },
          origin: "adopted" as const,
          lifecycle: "active" as const,
          verification: "verified" as const,
          filesystemEvidence: evidence,
        },
        {
          schemaVersion: 1 as const,
          id: "empty",
          projectId: "project-one",
          repositoryBindingId: "binding-one",
          title: "Empty",
          workspaceIdentity: "one-empty",
          worktreePath: "/repo-empty",
          worktreeGeneration: "gen-empty",
          isMainWorktree: false,
          head: { kind: "branch" as const, ref: "feature", oid: "abc" },
          origin: "adopted" as const,
          lifecycle: "active" as const,
          verification: "verified" as const,
          filesystemEvidence: { ...evidence, canonicalPath: "/repo-empty" },
        },
        {
          schemaVersion: 1 as const,
          id: "detached",
          projectId: "project-two",
          repositoryBindingId: "binding-two",
          title: "Detached",
          workspaceIdentity: "two-detached",
          worktreePath: "/repo-two",
          worktreeGeneration: "gen-detached",
          isMainWorktree: false,
          head: { kind: "detached" as const, oid: "def" },
          origin: "adopted" as const,
          lifecycle: "active" as const,
          verification: "verified" as const,
          filesystemEvidence: { ...evidence, canonicalPath: "/repo-two" },
        },
      ],
    },
    migration: {
      schemaVersion: 1 as const,
      source: { sourceKey: "fixture", fingerprint: "a".repeat(64), commandKey: "b".repeat(64) },
      records: [
        {
          hierarchySessionId: "native-one",
          nativeSessionId: "native-one",
          ownerKind: "native-v4" as const,
          targetId: "target",
          projectId: "project-one",
          workspaceId: "main",
          harnessId: "zcode",
          workspacePath: "/repo/subdir",
          workspaceIdentity: "one-main",
          cwdRelativeToWorktree: "subdir",
          status: "linked" as const,
        },
        {
          hierarchySessionId: "external-pending",
          nativeSessionId: "external-pending",
          ownerKind: "agent-host" as const,
          targetId: "target",
          projectId: "project-one",
          workspaceId: "main",
          harnessId: "pi",
          workspacePath: "/repo",
          workspaceIdentity: "one-main",
          cwdRelativeToWorktree: ".",
          status: "linked" as const,
        },
        {
          hierarchySessionId: "host-zcode",
          nativeSessionId: "host-zcode",
          ownerKind: "agent-host" as const,
          targetId: "target",
          projectId: "project-one",
          workspaceId: "main",
          harnessId: "zcode",
          workspacePath: "/repo/subdir",
          workspaceIdentity: "one-main",
          cwdRelativeToWorktree: "subdir",
          status: "linked" as const,
        },
      ],
    },
    directory: {
      schemaVersion: 1 as const,
      targetId: "target",
      status: "available" as const,
      entries: [
        {
          manifest: {
            schemaVersion: 1 as const,
            id: "zcode",
            name: "ZCode",
            adapterVersion: "native-v4",
            icon: { fallback: "initials" as const },
          },
          status: "registered" as const,
          source: "native" as const,
        },
        {
          manifest: {
            schemaVersion: 1 as const,
            id: "pi",
            name: "Pi",
            adapterVersion: "0.87.1",
            icon: { fallback: "initials" as const },
          },
          status: "unavailable" as const,
          source: "external" as const,
        },
      ],
    },
    summaries: [
      {
        spec: {
          schemaVersion: 1 as const,
          hostSessionId: "external-pending",
          execution: {
            targetId: "target",
            workspaceIdentity: "one-main",
            worktreePath: "/repo",
          },
          harness: { id: "pi", adapterVersion: "0.87.1" },
          modelBinding: { kind: "harness-managed" as const },
        },
        title: "Pi review session",
        lastKnownStatus: "unknown" as const,
        freshness: "offline" as const,
        recentOutcome: "unknown" as const,
        pendingInteractionCount: 1,
        unread: false,
        updatedAt: 1_780_000_123_000,
        archived: false,
        kind: "top-level" as const,
      },
    ],
    targetFreshness: new Map([["target", "live" as const]]),
  };
}

test("project sidebar projector retains empty/detached workspaces and disables unmapped external rows", () => {
  const model = buildProjectSidebarViewModel({ ...source(), appearance: "light" });
  assert.equal(model.snapshot.projects.length, 2);
  assert.equal(model.snapshot.projects[0]?.workspaces.length, 2);
  assert.equal(model.snapshot.projects[0]?.workspaces[1]?.sessions.length, 0);
  assert.equal(model.snapshot.projects[1]?.workspaces[0]?.head.kind, "detached");
  assert.equal(model.sessionActions.get("native-one")?.ownerKind, "native-v4");
  assert.equal(model.sessionActions.get("native-one")?.selectable, true);
  assert.equal(model.sessionActions.get("native-one")?.workspacePath, "/repo/subdir");
  assert.equal(model.snapshot.projects[0]?.workspaces[0]?.sessions[1]?.title, "Pi review session");
  assert.equal(
    model.snapshot.projects[0]?.workspaces[0]?.sessions[1]?.updatedAt,
    1_780_000_123_000,
  );
  assert.equal(model.snapshot.projects[0]?.workspaces[0]?.sessions[1]?.freshness, "offline");
  assert.equal(model.snapshot.projects[0]?.workspaces[0]?.sessions[1]?.recentOutcome, "unknown");
  assert.equal(model.snapshot.projects[0]?.workspaces[0]?.sessions[2]?.recentOutcome, "unknown");
  assert.equal(model.sessionActions.get("external-pending")?.ownerKind, "agent-host");
  assert.equal(model.sessionActions.get("external-pending")?.selectable, true);
  assert.equal(model.sessionActions.get("host-zcode")?.ownerKind, "agent-host");
  const hostOwner = model.sessionActions.get("host-zcode");
  assert.equal(hostOwner?.ownerKind, "agent-host");
  assert.equal(
    hostOwner?.ownerKind === "agent-host" ? hostOwner.ownerLocator : undefined,
    undefined,
  );
  assert.equal(model.sessionActions.get("host-zcode")?.workspacePath, "/repo/subdir");
  assert.equal(model.sessionActions.get("host-zcode")?.selectable, false);
  assert.equal(
    model.sessionActions.get("host-zcode")?.reason,
    "external-session-mapping-unavailable",
  );
});

test("external sidebar route carries the exact linked owner, target attachment, and generation", () => {
  const model = buildProjectSidebarViewModel({ ...source(), appearance: "light" });
  const action = model.sessionActions.get("external-pending");
  assert.equal(action?.ownerKind, "agent-host");
  assert.ok(action?.ownerKind === "agent-host" && action.ownerLocator);
  if (action?.ownerKind !== "agent-host" || !action.ownerLocator) return;

  assert.equal(isValidAgentHostConversationOwner(action.ownerLocator), true);
  assert.equal(action.ownerLocator.ownerRecord.workspacePath, "/repo");
  assert.equal(action.ownerLocator.sessionSpec.execution.worktreePath, "/repo");
  assert.equal(action.ownerLocator.sessionSpec.hostSessionId, "external-pending");
  const whitespaceIdentityOwner = {
    ...action.ownerLocator,
    sessionSpec: {
      ...action.ownerLocator.sessionSpec,
      execution: {
        ...action.ownerLocator.sessionSpec.execution,
        workspaceIdentity: "one-main ",
      },
    },
  };
  assert.equal(isValidAgentHostConversationOwner(whitespaceIdentityOwner), false);

  const selected = {
    ...action.ownerLocator,
    remoteSessionId: "attachment-one",
    selectionGeneration: 1,
  } as const;
  assert.notEqual(
    agentHostConversationOwnerKey(selected),
    agentHostConversationOwnerKey({ ...selected, remoteSessionId: "attachment-two" }),
  );
  assert.notEqual(
    agentHostConversationOwnerKey(selected),
    agentHostConversationOwnerKey({ ...selected, selectionGeneration: 2 }),
  );
  assert.notEqual(
    agentHostConversationOwnerKey(selected),
    agentHostConversationOwnerKey({
      ...selected,
      sessionSpec: whitespaceIdentityOwner.sessionSpec,
    }),
  );
});

test("same path and session ID from a different target cannot satisfy a linked owner", () => {
  const value = source();
  value.summaries = value.summaries.filter(
    (summary) => summary.spec.hostSessionId !== "external-pending",
  );
  const otherTargetSummary = source().summaries.find(
    (summary) => summary.spec.hostSessionId === "external-pending",
  )!;
  value.summaries.push({
    ...otherTargetSummary,
    spec: {
      ...otherTargetSummary.spec,
      execution: { ...otherTargetSummary.spec.execution, targetId: "target-two" },
    },
  });

  const model = buildProjectSidebarViewModel({ ...value, appearance: "light" });
  const action = model.sessionActions.get("external-pending");
  assert.equal(action?.selectable, false);
  assert.equal(action?.ownerKind === "agent-host" ? action.ownerLocator : undefined, undefined);
});

test("canonical session workspace identities remain byte-exact during sidebar matching", () => {
  const value = source();
  const record = value.migration.records.find(
    (candidate) => candidate.hierarchySessionId === "external-pending",
  )!;
  record.workspaceIdentity = "one-main ";

  const model = buildProjectSidebarViewModel({ ...value, appearance: "light" });
  const action = model.sessionActions.get("external-pending");
  assert.equal(action?.selectable, false);
  assert.equal(action?.workspaceIdentity, "one-main ");
  assert.equal(action?.ownerKind === "agent-host" ? action.ownerLocator : undefined, undefined);
});

test("project sidebar preserves an explicit no-prior-turn outcome", () => {
  const value = source();
  const template = value.summaries[0]!;
  value.summaries.push({
    ...template,
    spec: {
      ...template.spec,
      hostSessionId: "host-zcode",
      execution: { ...template.spec.execution, worktreePath: "/repo/subdir" },
      harness: { id: "zcode", adapterVersion: "native-v4" },
    },
    title: "Fresh session",
    recentOutcome: "none",
  });
  const model = buildProjectSidebarViewModel({ ...value, appearance: "light" });
  const hostSession = model.snapshot.projects[0]?.workspaces[0]?.sessions[2];

  assert.equal(hostSession?.recentOutcome, "none");
});

test("empty first-run catalog retains an empty Project management model for the mount fallback", () => {
  const value = source();
  const empty = buildProjectSidebarViewModel({
    ...value,
    catalog: { schemaVersion: 1, projects: [] },
    worktrees: { ...value.worktrees, bindings: [], workspaces: [] },
    migration: { ...value.migration, records: [] },
    appearance: "light",
  });
  assert.equal(empty.snapshot.projects.length, 0);
});

test("native task metadata supplies its persisted title and update time without changing its owner cwd", () => {
  const model = buildProjectSidebarViewModel({
    ...source(),
    nativeSessionMetadata: new Map([
      ["native-one", { title: "Native task title", updatedAt: 1_780_001_234_000 }],
    ]),
    appearance: "light",
  });
  const session = model.snapshot.projects[0]?.workspaces[0]?.sessions[0];

  assert.equal(session?.title, "Native task title");
  assert.equal(session?.updatedAt, 1_780_001_234_000);
  assert.equal(model.sessionActions.get("native-one")?.workspacePath, "/repo/subdir");
  assert.equal(model.sessionActions.get("native-one")?.nativeSessionId, "native-one");
});
