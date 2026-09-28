import assert from "node:assert/strict";
import test from "node:test";
import { ProjectSidebarRequestFence } from "../src/project-sidebar/requestFence.js";

test("sidebar request fence rejects results from an old workspace scope", () => {
  const fence = new ProjectSidebarRequestFence();
  const services = {};
  const previous = fence.activate({
    workspaceScopeKey: "local:/repo-one",
    remoteSessionId: null,
    connectionKind: "local-ready",
    services,
  });
  const current = fence.activate({
    workspaceScopeKey: "local:/repo-two",
    remoteSessionId: null,
    connectionKind: "local-ready",
    services,
  });

  assert.equal(fence.isCurrent(previous), false);
  assert.equal(fence.isCurrent(current), true);
});

test("sidebar request fence rejects results from an older Host attachment in the same workspace", () => {
  const fence = new ProjectSidebarRequestFence();
  const firstServices = {};
  const oldHost = fence.activate({
    workspaceScopeKey: "remote:host-a:/repo",
    remoteSessionId: "remote-session",
    connectionKind: "remote-ready",
    services: firstServices,
  });
  const disconnected = fence.activate({
    workspaceScopeKey: "remote:host-a:/repo",
    remoteSessionId: null,
    connectionKind: "remote-waiting",
    services: {},
  });
  const reattached = fence.activate({
    workspaceScopeKey: "remote:host-a:/repo",
    remoteSessionId: "remote-session",
    connectionKind: "remote-ready",
    services: {},
  });

  assert.equal(fence.isCurrent(oldHost), false);
  assert.equal(fence.isCurrent(disconnected), false);
  assert.equal(fence.isCurrent(reattached), true);
});
