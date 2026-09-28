export async function runProjectSidebarFreshnessScenarios(context) {
  const {
    browser,
    pageValue,
    waitFor,
    waitForBodyText,
    click,
    fill,
    capture,
    counters,
    fixtureApi,
    assertStep,
    screenshots,
    sleep,
  } = context;
  fill("input[aria-label='Project name']", "Keep focus during summary update");
  browser("eval", "window.__projectSidebarFixture.prepareFocusedInput(); true");
  const focusBefore = fixtureApi("checkFocusedInput()");
  const countersBeforeEvent = counters();
  const selectionBeforeEvent = fixtureApi("getViewState()");
  browser("eval", "window.__projectSidebarFixture.emitBackgroundEvent(); true");
  await waitForBodyText("Background summary updated");
  const focusAfter = fixtureApi("checkFocusedInput()");
  const countersAfterEvent = counters();
  const selectionAfterEvent = fixtureApi("getViewState()");
  assertStep(
    focusBefore.sameNode &&
      focusBefore.focused &&
      focusAfter.sameNode &&
      focusAfter.focused &&
      focusAfter.value === focusBefore.value &&
      focusAfter.selectionStart === focusBefore.selectionStart &&
      focusAfter.selectionEnd === focusBefore.selectionEnd,
    "background summary update preserves the focused input DOM node, value and text selection",
  );
  assertStep(
    JSON.stringify(selectionBeforeEvent) === JSON.stringify(selectionAfterEvent),
    "background summary event leaves active Project/Workspace/Session selection unchanged",
  );
  assertStep(
    countersAfterEvent.catalogReads === countersBeforeEvent.catalogReads &&
      countersAfterEvent.worktreeReads === countersBeforeEvent.worktreeReads &&
      countersAfterEvent.hierarchyReads === countersBeforeEvent.hierarchyReads &&
      countersAfterEvent.availabilityReads === countersBeforeEvent.availabilityReads &&
      countersAfterEvent.taskListReads === countersBeforeEvent.taskListReads &&
      countersAfterEvent.directoryReads === countersBeforeEvent.directoryReads &&
      countersAfterEvent.summaryReadsByWorkspace["/fixture/repo/linked\0/fixture/repo/linked"] ===
        countersBeforeEvent.summaryReadsByWorkspace["/fixture/repo/linked\0/fixture/repo/linked"] +
          1,
    "runtime event refreshes only one affected lightweight summary without Catalog, Worktree, migration or task-index reads",
  );
  capture("two Projects with multiple workspaces and sessions", screenshots.hierarchy);

  const readsBeforeHostRace = counters().catalogReads;
  browser("eval", "window.__projectSidebarFixture.holdNextCatalogRead(); true");
  click("button[aria-label='Refresh project workspaces']");
  await waitFor(
    "held old-Host refresh",
    `window.__projectSidebarFixture.counters().catalogReads > ${readsBeforeHostRace}`,
  );
  click("button[data-fixture-action='switch-host']");
  await waitForBodyText("Host generation two title");
  browser("eval", "window.__projectSidebarFixture.releaseHeldCatalogReads(); true");
  await sleep(500);
  assertStep(
    pageValue(
      "document.body.innerText.includes('Host generation two title') && !document.body.innerText.includes('Review the project hierarchy')",
    ),
    "late summary refresh from the prior Host generation cannot overwrite the new Host data",
  );

  if (
    !pageValue(
      "Boolean(document.querySelector('[data-project-sidebar-add-form] input[aria-label=\"Project name\"]'))",
    )
  ) {
    click("button[data-project-sidebar-add-project='true']");
    await waitFor(
      "Project form after Host generation change",
      "document.querySelector('[data-project-sidebar-add-form] input[aria-label=\"Project name\"]')",
    );
  }
  browser("set", "viewport", "390", "844");
  await sleep(500);
  const mobileMetrics = pageValue(`JSON.stringify({
    fontSize: getComputedStyle(document.querySelector('[data-project-sidebar-add-form] input[aria-label="Project name"]')).fontSize,
    addButtonHeight: document.querySelector('[data-project-sidebar-add-project]').getBoundingClientRect().height,
    viewportWidth: innerWidth
  })`);
  assertStep(
    mobileMetrics.viewportWidth === 390 && mobileMetrics.fontSize === "16px",
    "mobile editable controls keep the 16px focus-safe size",
  );
  assertStep(
    mobileMetrics.addButtonHeight >= 32,
    "mobile Project creation action remains touch-sized",
  );
  capture("mobile project sidebar", screenshots.mobile);
  browser("set", "viewport", "1280", "900");
  click("button[data-fixture-action='toggle-locale']");
  await waitForBodyText("项目工作区");
  assertStep(
    pageValue(
      "document.querySelector('[data-project-sidebar-add-form] input[aria-label=\"项目名称\"]') !== null",
    ),
    "Chinese locale translates the Project management form",
  );
  click("button[data-fixture-action='toggle-locale']");
  await waitForBodyText("Project workspaces");

  browser("eval", "window.__projectSidebarFixture.setTargetOffline(true); true");
  click("button[aria-label='Refresh project workspaces']");
  await waitForBodyText("offline");
  assertStep(
    pageValue(
      "Boolean(document.querySelector('[data-project-sidebar-project]') && document.querySelector('details[data-project-sidebar-legacy-compat]'))",
    ),
    "same-scope offline keeps the last-ready Project tree visible",
  );
  assertStep(
    !pageValue("[...document.querySelectorAll('[aria-label=\"Last turn completed\"]')].length"),
    "same-scope offline does not fabricate a completed session outcome",
  );
  capture("same-scope offline preserves stale tree", screenshots.offline);
  browser("eval", "window.__projectSidebarFixture.setTargetOffline(false); true");
  click("button[aria-label='Refresh project workspaces']");
  await waitForBodyText("Host generation two title");

  browser("eval", "window.__projectSidebarFixture.setOldHostUnavailable(true); true");
  click("button[aria-label='Refresh project workspaces']");
  await waitForBodyText("The project sidebar is unavailable.");
  assertStep(
    pageValue(
      "document.querySelector('[data-legacy-workspace]') && !document.querySelector('[data-project-sidebar]')",
    ),
    "an older Host without the directory capability falls back to real legacy task DOM",
  );
  capture("old Host fallback", screenshots.fallback);
  browser("eval", "window.__projectSidebarFixture.setOldHostUnavailable(false); true");
  browser("eval", "window.__projectSidebarFixture.switchHostGeneration(); true");
  await waitForBodyText("Host generation two title");

  const projectIdsBeforeWorkspaceSwitch = fixtureApi("getCatalogProjectIds()");
  const currentReads = counters().catalogReads;
  browser("eval", "window.__projectSidebarFixture.holdNextCatalogRead(); true");
  click("button[aria-label='Refresh project workspaces']");
  await waitFor(
    "held old-scope Catalog read",
    `window.__projectSidebarFixture.counters().catalogReads > ${currentReads}`,
  );
  click("button[data-fixture-action='switch-scope']");
  await waitFor(
    "active workspace path changes while the Project Catalog stays profile-scoped",
    "document.querySelector('[data-fixture-scope]')?.textContent === '/fixture/other'",
  );
  browser("eval", "window.__projectSidebarFixture.releaseHeldCatalogReads(); true");
  await sleep(500);
  assertStep(
    pageValue(
      "JSON.stringify(window.__projectSidebarFixture.getCatalogProjectIds()) === JSON.stringify(" +
        JSON.stringify(projectIdsBeforeWorkspaceSwitch) +
        ") && Boolean(document.querySelector('[data-project-sidebar-project]')) && document.body.innerText.includes('Orca UI')",
    ),
    "switching the active workspace does not redefine Project membership, and a late read cannot erase the profile tree",
  );
}
