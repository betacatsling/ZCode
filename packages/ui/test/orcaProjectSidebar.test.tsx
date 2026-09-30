import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import { acceptHarnessAssetSource, HarnessIcon } from "../src/agent-host/HarnessIcon.js";
import { HarnessSelector } from "../src/agent-host/HarnessSelector.js";
import { ModelBindingSelector } from "../src/agent-host/ModelBindingSelector.js";
import { CompatibilityStatus } from "../src/agent-host/CompatibilityStatus.js";
import { admitsExecution, isUnverifiedCapability } from "../src/agent-host/SessionCapabilities.js";
import {
  OrcaProjectSidebar,
  type OrcaSidebarHandlers,
} from "../src/project-sidebar/OrcaProjectSidebar.js";
import {
  formatSidebarRelativeTime,
  orcaSidebarCopy,
} from "../src/project-sidebar/orcaSidebarCopy.js";
import {
  orcaDiscoveredCandidates,
  orcaHarnessAssets,
  orcaHarnessDirectory,
  orcaModelOptions,
  orcaSidebarNow,
  orcaSidebarSnapshot,
  orcaSidebarView,
} from "../src/project-sidebar/orcaSidebarFixture.js";
import type { SidebarSnapshot } from "../src/project-sidebar/planTypes.js";
import {
  createOrcaSidebarViewStore,
  orderByIds,
  type OrcaSidebarViewData,
} from "../src/project-sidebar/sidebarViewStore.js";

const handlers: OrcaSidebarHandlers = {
  onToggleProject: () => undefined,
  onToggleWorkspace: () => undefined,
  onSelectSession: () => {
    throw new Error("snapshot render selected a session");
  },
  onAddWorkspace: () => undefined,
  onOpenMenu: () => undefined,
  onRevealAttention: () => undefined,
  onWorkspaceDraftChange: () => undefined,
  onCancelWorkspace: () => undefined,
  onSubmitWorkspace: () => {
    throw new Error("snapshot render submitted a workspace");
  },
  onOpenDiscovered: () => undefined,
  onCloseDiscovered: () => undefined,
  onAdoptDiscovered: () => {
    throw new Error("snapshot render adopted a worktree");
  },
  onOpenAgent: () => undefined,
  onAgentDraftChange: () => undefined,
  onCloseAgent: () => undefined,
  onCreateAgent: () => {
    throw new Error("snapshot render created an agent");
  },
  onScroll: () => undefined,
};

function renderTree(
  view: OrcaSidebarViewData = orcaSidebarView,
  snapshot: SidebarSnapshot = orcaSidebarSnapshot,
  locale: "zh-CN" | "en-US" = "zh-CN",
  appearance: "light" | "dark" = "light",
  query = "",
): string {
  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale={locale}>
      <OrcaProjectSidebar
        snapshot={snapshot}
        view={view}
        directory={orcaHarnessDirectory}
        assets={orcaHarnessAssets}
        appearance={appearance}
        now={orcaSidebarNow}
        query={query}
        models={orcaModelOptions}
        report={{ support: "supported" }}
        discoveredByProject={{ "project-zcode": [...orcaDiscoveredCandidates] }}
        handlers={handlers}
      />
    </ZCodeIntlProvider>,
  );
}

function iconTags(markup: string): string[] {
  return [
    ...markup.matchAll(
      /<img\b[^>]*data-harness-icon="true"[^>]*>|<span\b[^>]*data-harness-icon="true"[^>]*>[\s\S]*?<\/span>/g,
    ),
  ].map((match) => match[0]);
}

function openingTag(markup: string, marker: string): string {
  const index = markup.indexOf(marker);
  assert.notEqual(index, -1, marker);
  const start = markup.lastIndexOf("<", index);
  const end = markup.indexOf(">", index);
  return markup.slice(start, end + 1);
}

test("fixture has two projects, two workspaces each, and three sessions with two on the same harness", () => {
  assert.equal(orcaSidebarSnapshot.projects.length, 2);
  for (const project of orcaSidebarSnapshot.projects) {
    assert.ok(project.workspaces.length >= 2);
  }
  const feature = orcaSidebarSnapshot.projects[0]?.workspaces[1];
  assert.equal(feature?.sessions.length, 3);
  const harnessIds = feature?.sessions.map((row) => row.session.harnessId);
  assert.deepEqual(harnessIds, ["pi", "pi", "codex"]);
  assert.equal(feature?.workspace.isMainWorktree, false);
  assert.equal(
    feature?.workspace.head.kind === "branch" ? feature.workspace.head.ref : "",
    "feature/sidebar",
  );
});

test("session rows use the directory icon, status, title, and relative time", () => {
  const markup = renderTree();
  const featureIcons = iconTags(markup).filter((tag) => tag.includes('data-harness-id="pi"'));
  assert.equal(featureIcons.length, 2);
  for (const tag of featureIcons) {
    assert.match(tag, /data-harness-asset-id="pi-light"/);
    assert.match(tag, /data-harness-name="Pi"/);
    assert.doesNotMatch(tag, /glm-4\.6|claude-sonnet|调研|实现/);
  }
  assert.match(markup, /data-model-label="glm-4\.6"/);
  assert.match(markup, /data-model-label="claude-sonnet"/);
  assert.match(markup, /data-session-title="true"/);
  assert.match(markup, /data-session-status="true"/);
  const researchAt = orcaSidebarSnapshot.projects[0]?.workspaces[1]?.sessions[0]?.updatedAt ?? 0;
  assert.match(markup, new RegExp(`data-updated-at="${researchAt}"`));
  assert.ok(markup.includes(formatSidebarRelativeTime(researchAt, orcaSidebarNow, "zh-CN")));
  assert.doesNotMatch(markup, /data-harness-id="decoy-model-name"/);
  assert.equal(markup.includes("data-session-id"), true);
  const ids = [...markup.matchAll(/data-session-id="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids.slice(0, 3), ["s-research", "s-session", "s-review"]);
});

test("unknown or unsafe harness assets fall back without guessing a brand or requesting a URL", () => {
  const markup = renderTree();
  const unknown = iconTags(markup).find((tag) => tag.includes('data-harness-id="new-harness"'));
  assert.ok(unknown);
  assert.match(unknown, /data-harness-known="false"/);
  assert.match(unknown, /data-harness-name="new-harness"/);
  assert.match(unknown, />N</);
  assert.doesNotMatch(unknown, /GLM|Codex|glm/);

  const scriptSvg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')}`;
  assert.equal(acceptHarnessAssetSource(scriptSvg), null);
  assert.equal(acceptHarnessAssetSource("https://evil.example/logo.svg"), null);
  const unsafe = renderToStaticMarkup(
    <HarnessIcon
      harnessId="codex"
      appearance="light"
      directory={[{ harnessId: "codex", name: "Codex", lightAssetId: "bad", fallback: "generic" }]}
      assets={{ bad: "https://evil.example/logo.svg" }}
    />,
  );
  assert.doesNotMatch(unsafe, /<img|evil\.example|<script|GLM/);
  assert.match(unsafe, /data-harness-name="Codex"/);
});

test("main checkout and default workspace stay distinct from the branch name", () => {
  const markup = renderTree();
  assert.match(openingTag(markup, 'data-workspace-id="ws-main"'), /data-main-worktree="true"/);
  const feature = openingTag(markup, 'data-workspace-id="ws-feature"');
  assert.match(feature, /data-main-worktree="false"/);
  assert.match(markup, /data-workspace-id="ws-main"[\s\S]*?data-main-badge="true"/);
  assert.match(markup, /data-workspace-id="ws-feature"[\s\S]*?data-default-badge="true"/);
  const branchStart = markup.indexOf('data-workspace-id="ws-docs-branch"');
  const branch = markup.slice(branchStart, markup.indexOf("</section>", branchStart));
  assert.match(branch, /data-main-worktree="false"/);
  assert.doesNotMatch(branch, /data-main-badge/);
  assert.match(branch, /\[server1\] main/);
});

test("background snapshot updates keep the selected session and do not reorder or invoke selection", () => {
  const next = structuredClone(orcaSidebarSnapshot);
  const session = next.projects[0]?.workspaces[1]?.sessions[1];
  assert.ok(session);
  session.activity = "idle";
  session.updatedAt = orcaSidebarNow;
  session.recentOutcome = "succeeded";
  const before = renderTree();
  const after = renderTree(orcaSidebarView, next);
  for (const markup of [before, after]) {
    assert.match(openingTag(markup, 'data-session-id="s-research"'), /data-active="true"/);
    assert.match(openingTag(markup, 'data-session-id="s-session"'), /data-active="false"/);
    const ids = [...markup.matchAll(/data-session-id="([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(ids.slice(0, 3), ["s-research", "s-session", "s-review"]);
  }
  assert.doesNotMatch(after, /autoFocus|autofocus/i);
});

test("collapsed, hidden, and filtered rows keep the full agent count and pending entry", () => {
  const collapsed = renderTree({
    ...orcaSidebarView,
    expandedWorkspaceIds: orcaSidebarView.expandedWorkspaceIds.filter((id) => id !== "ws-feature"),
  });
  assert.match(openingTag(collapsed, 'data-workspace-id="ws-feature"'), /data-agent-count="3"/);
  assert.doesNotMatch(collapsed, /data-session-id="s-research"/);
  assert.match(collapsed, /data-pending-count="1"/);
  assert.match(collapsed, /data-running-count="2"/);

  const hidden = renderTree({
    ...orcaSidebarView,
    hiddenWorkspaceIds: ["ws-docs-branch"],
  });
  assert.doesNotMatch(hidden, /data-workspace-id="ws-docs-branch"/);
  assert.match(openingTag(hidden, 'data-project-id="project-docs"'), /data-agent-count="2"/);
  assert.match(hidden, /data-attention-entry="project-docs"/);

  const filtered = renderTree(orcaSidebarView, orcaSidebarSnapshot, "zh-CN", "light", "调研");
  assert.match(filtered, /匹配 1 \/ 总 3/);
  assert.match(openingTag(filtered, 'data-workspace-id="ws-feature"'), /data-agent-count="3"/);
  assert.match(filtered, /data-session-id="s-research"/);
  assert.doesNotMatch(filtered, /data-session-id="s-session"/);
});

test("english and chinese copy follow the active locale", () => {
  assert.match(renderTree(), /3 个 Agent/);
  assert.match(renderTree(orcaSidebarView, orcaSidebarSnapshot, "en-US"), /3 agents/);
  assert.equal(orcaSidebarCopy("en-US").mainCheckout, "Main checkout");
});

test("offline freshness stays visible when the latest turn succeeded", () => {
  const markup = renderTree();
  const offline = markup.slice(markup.indexOf('data-session-id="s-docs-offline"'));
  assert.match(offline, /data-freshness="offline"/);
  assert.match(offline, /data-outcome="succeeded"/);
  assert.match(offline, /data-attention="idle"/);
  assert.match(offline, /离线/);
});

test("view store changes selection only through an explicit user action", () => {
  const store = createOrcaSidebarViewStore({ activeSessionId: "s-research", scrollTop: 24 });
  store.getState().setDraft("s-research", "保留的草稿");
  store.getState().setScrollTop(80);
  store.getState().openAgentDraft("ws-feature");
  assert.equal(store.getState().activeSessionId, "s-research");
  assert.equal(store.getState().drafts["s-research"], "保留的草稿");
  assert.equal(store.getState().scrollTop, 80);
  store.getState().selectSession("s-review");
  assert.equal(store.getState().activeSessionId, "s-review");
  assert.equal("applySnapshot" in store.getState(), false);
  assert.deepEqual(
    orderByIds(
      [
        { id: "newer", updatedAt: 9 },
        { id: "older", updatedAt: 1 },
      ],
      ["older", "newer"],
    ).map((item) => item.id),
    ["older", "newer"],
  );
});

test("dialogs and selectors receive directory data without creating sessions during render", () => {
  const open = renderTree({
    ...orcaSidebarView,
    workspaceDialogProjectId: "project-zcode",
    discoveredProjectId: "project-zcode",
    agentWorkspaceId: "ws-feature",
  });
  assert.match(open, /data-workspace-dialog="ZCode"/);
  assert.match(open, /Local Mac/);
  assert.match(open, /data-discovered-id="discovered-linked"/);
  assert.match(open, /data-discovered-id="discovered-detached"/);
  assert.match(open, /此工作区中的 Agent 会共享文件改动/);
  assert.match(open, /data-harness-option="pi"/);
  assert.match(open, /data-model-option="glm-4\.6"/);
  assert.doesNotMatch(open, /data-model-option="pi"/);

  const selector = renderToStaticMarkup(
    <HarnessSelector
      directory={orcaHarnessDirectory}
      assets={orcaHarnessAssets}
      appearance="dark"
      value="pi"
      label="Choose Harness"
      onChange={() => {
        throw new Error("selector changed during render");
      }}
    />,
  );
  assert.match(openingTag(selector, 'data-harness-option="pi"'), /aria-selected="true"/);
  assert.match(selector, /data-harness-asset-id="pi-dark"/);

  const models = renderToStaticMarkup(
    <ModelBindingSelector
      options={orcaModelOptions}
      value="glm-4.6"
      label="Choose model"
      kindLabel={(kind) => kind}
      onChange={() => {
        throw new Error("model changed during render");
      }}
    />,
  );
  assert.doesNotMatch(models, /data-harness-icon/);

  const copy = orcaSidebarCopy("zh-CN");
  const compatibility = renderToStaticMarkup(
    <CompatibilityStatus
      requestedLabel="glm-4.6"
      effectiveLabel="claude-sonnet"
      report={{ support: "experimental", reason: "仍在核实" }}
      copy={copy}
    />,
  );
  assert.match(compatibility, /data-compatibility-mismatch="true"/);
  assert.match(compatibility, /data-compatibility-executable="false"/);
  assert.match(compatibility, /请求的模型与实际生效模型不一致/);
  assert.equal(admitsExecution({ support: "experimental", reason: "仍在核实" }), false);
  assert.equal(isUnverifiedCapability({ support: "unknown", reason: "缺少报告" }), true);
  assert.equal(admitsExecution({ support: "supported" }), true);
});
