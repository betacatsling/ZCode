import assert from "node:assert/strict";
import test from "node:test";
import type { MountedSessionOwner } from "../src/v4/mountedSessionOwner.js";
import {
  matchesMountedSessionOwner,
  sameMountedExternalOwner,
} from "../src/v4/mountedSessionOwner.js";

const scope = {
  targetId: "target-A",
  workspaceId: "tree-A",
  workspaceIdentity: "remote:key",
  workspacePath: "/tree",
  remoteSessionId: "connection-A",
};
const owner: MountedSessionOwner = {
  kind: "external",
  scope,
  spec: {
    schemaVersion: 2,
    hostSessionId: "pi-1",
    workspaceId: scope.workspaceId,
    projectId: "project-A",
    execution: {
      targetId: scope.targetId,
      workspaceIdentity: scope.workspaceIdentity,
      worktreePath: scope.workspacePath,
      worktreeGeneration: "gen-1",
      cwdRelativeToWorktree: ".",
    },
    harness: { id: "pi", adapterVersion: "1" },
    modelBinding: { kind: "harness-managed" },
  },
  historyOnly: false,
};
const pane = {
  workspacePath: "/tree",
  workspaceIdentity: "remote:key",
  remoteSessionId: "connection-A",
};

test("external mount accepts only full identity, target, persisted workspace and original Host ID", () => {
  assert.equal(matchesMountedSessionOwner(owner, "pi-1", pane), true);
  assert.equal(matchesMountedSessionOwner(owner, "pi-2", pane), false);
  assert.equal(
    matchesMountedSessionOwner(owner, "pi-1", { ...pane, workspaceIdentity: "remote:other" }),
    false,
  );
  assert.equal(
    matchesMountedSessionOwner(owner, "pi-1", { ...pane, remoteSessionId: "connection-B" }),
    false,
  );
  assert.equal(
    matchesMountedSessionOwner(owner, "pi-1", { ...pane, workspacePath: "/rebuilt" }),
    false,
  );
  if (owner.kind !== "external") throw new Error("fixture owner");
  assert.equal(
    matchesMountedSessionOwner(
      {
        ...owner,
        spec: { ...owner.spec, execution: { ...owner.spec.execution, targetId: "target-B" } },
      },
      "pi-1",
      pane,
    ),
    false,
  );
  assert.equal(
    matchesMountedSessionOwner(
      { ...owner, spec: { ...owner.spec, workspaceId: "tree-B" } },
      "pi-1",
      pane,
    ),
    false,
  );
});

test("owner comparison normalizes schema property order but rejects changed target/spec", () => {
  if (owner.kind !== "external") throw new Error("fixture owner");
  const reordered: typeof owner = {
    kind: "external",
    historyOnly: false,
    spec: {
      modelBinding: owner.spec.modelBinding,
      harness: owner.spec.harness,
      execution: owner.spec.execution,
      workspaceId: owner.spec.workspaceId,
      projectId: owner.spec.projectId,
      hostSessionId: owner.spec.hostSessionId,
      schemaVersion: 2,
    },
    scope: {
      workspacePath: scope.workspacePath,
      remoteSessionId: scope.remoteSessionId,
      workspaceIdentity: scope.workspaceIdentity,
      workspaceId: scope.workspaceId,
      targetId: scope.targetId,
    },
  };
  assert.equal(sameMountedExternalOwner(owner, reordered), true);
  assert.equal(
    sameMountedExternalOwner(owner, {
      ...reordered,
      scope: { ...reordered.scope, targetId: "other-target" },
    }),
    false,
  );
});

test("native alias never replaces original runtime ID; local path fallback only with matching scope", () => {
  const native: MountedSessionOwner = { kind: "native", scope, originalSessionId: "native-real" };
  assert.equal(matchesMountedSessionOwner(native, "native-alias", pane), false);
  assert.equal(matchesMountedSessionOwner(native, "native-real", pane), true);
  const local: MountedSessionOwner = {
    kind: "native",
    scope: {
      targetId: "local",
      workspaceId: "main",
      workspaceIdentity: "/repo",
      workspacePath: "/repo",
    },
    originalSessionId: "native-local",
  };
  assert.equal(matchesMountedSessionOwner(local, "native-local", { workspacePath: "/repo" }), true);
  assert.equal(
    matchesMountedSessionOwner(local, "native-local", { workspacePath: "/wrong" }),
    false,
  );
});
