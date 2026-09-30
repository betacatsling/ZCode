/**
 * Render guard for the project-sidebar "create Agent" form (no DOM runtime in this repo, so
 * this pins the server-rendered first frame; effects do not run). Pins exact markup hashes for
 * a live and a cached workspace plus readable facts, so a refactor of the form (e.g. moving
 * its state into a hook) must keep the rendered output byte-identical.
 * Intentional UI changes: update the hashes from the failure message.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SidebarWorkspaceNode } from "@zcode/shared/agent-host";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { ProjectSidebarAgentCreateForm } from "../src/project-sidebar/ProjectSidebarAgentCreateForm.js";
import type {
  ProjectSidebarTargetOption,
  ProjectSidebarTargetServices,
} from "../src/project-sidebar/contract.js";

const summary = {
  sessionCount: 0,
  agentCount: 0,
  pendingInteractionCount: 0,
  runningCount: 0,
  errorCount: 0,
  unknownCount: 0,
  unreadCount: 0,
  attention: "none",
} as SidebarWorkspaceNode["summary"];

function workspace(targetFreshness: SidebarWorkspaceNode["targetFreshness"]): SidebarWorkspaceNode {
  return {
    workspaceId: "workspace-1",
    projectId: "project-1",
    repositoryBindingId: null,
    targetId: "target-1",
    targetFreshness,
    verification: "verified",
    title: "Main worktree",
    worktreePath: "/repo",
    head: null,
    isMainWorktree: true,
    lifecycle: "active",
    sessions: [],
    summary,
  };
}

const targetOption: ProjectSidebarTargetOption = {
  targetId: "target-1",
  attachmentGeneration: 1,
  remoteSessionId: null,
  isLocal: true,
  writable: true,
  targetPresentation: { kind: "local" },
};

const pending = () => new Promise<never>(() => {});
const liveServices = {
  agentHostService: { getAvailability: pending, getDirectory: pending },
  modelSelectionService: { onDidChange: () => ({ dispose() {} }), getView: pending },
} as unknown as ProjectSidebarTargetServices;

function render(
  freshness: SidebarWorkspaceNode["targetFreshness"],
  services: ProjectSidebarTargetServices | null,
) {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale="en-US">
      <ProjectSidebarAgentCreateForm
        workspace={workspace(freshness)}
        targetOption={targetOption}
        targetServices={services}
        worktreeGeneration="generation-1"
        appearance="light"
        targetLabel="This Mac"
        onCancel={() => {}}
        onCreateAgent={async () => {}}
      />
    </ZCodeIntlProvider>,
  );
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("live workspace: first frame is the loading form with a disabled submit", () => {
  const markup = render("live", liveServices);
  assert.match(markup, /data-project-sidebar-agent-create="true"/);
  assert.match(markup, /Main worktree/);
  assert.match(markup, /This Mac/);
  assert.match(markup, /maxLength="256"/);
  assert.match(markup, /type="submit" disabled="">Create Agent<\/button>/);
  assert.match(markup, /Loading target models/);
  assert.doesNotMatch(markup, /role="alert"|Cached workspace data/);
  assert.equal(sha256(markup), LIVE_HASH, `live markup changed:\n${markup}`);
});

test("cached workspace without services: read-only reason and unavailable model status", () => {
  const markup = render("stale", null);
  assert.match(markup, /data-project-sidebar-agent-create="true"/);
  assert.match(markup, /No available model selection for this target\./);
  assert.match(markup, /Cached workspace data is read-only/);
  assert.match(markup, /type="submit" disabled="">Create Agent<\/button>/);
  assert.equal(sha256(markup), CACHED_HASH, `cached markup changed:\n${markup}`);
});

const LIVE_HASH = "e631bff96c3b52959b4aaaae0b727c13f7db2614706f6a7d72a5d8ab5ed7d3b2";
const CACHED_HASH = "d4db1b21837eb58407b74828a3b1e12994fdc1904c8c891b281b40309fc3b602";
