/* eslint-disable max-lines -- One browser workflow preserves the exact sequence and assertions across import, recovery, projection, and legacy history. */
export async function runProjectSidebarWorkflowScenarios(context) {
  const {
    browser,
    pageValue,
    waitFor,
    waitForBodyText,
    click,
    fill,
    counters,
    fixtureApi,
    assertStep,
    record,
  } = context;
  const scrollAddProjectIntoView = () =>
    pageValue(
      "document.querySelector('button[data-project-sidebar-add-project=\"true\"]')?.scrollIntoView({ block: 'center' }); true",
    );
  const beforeCandidateSelection = counters();
  assertStep(
    beforeCandidateSelection.createProjectCalls === 0 &&
      beforeCandidateSelection.adoptionCalls === 0,
    "discovery creates no Project and adopts no implicit first candidate",
  );
  browser("snapshot", "-i");
  click("button[data-fixture-action='fail-next-project-create']");
  click("button[data-project-sidebar-candidate='/fixture/repo/linked']");
  await waitForBodyText("fixture-project-create-failed");
  const failedAdoption = counters();
  assertStep(
    failedAdoption.createProjectCalls === 1 &&
      failedAdoption.adoptionCalls === 0 &&
      failedAdoption.workspaceRefWrites === 0 &&
      fixtureApi("getCatalogProjectIds()").length === 0 &&
      pageValue("Boolean(document.querySelector('[data-legacy-workspace]'))"),
    "failed Project metadata write leaves Catalog and Worktree unchanged while the selected candidate and legacy DOM remain recoverable",
  );
  await waitFor(
    "selected candidate remains visible for the same-intent retry",
    "document.querySelector('[data-project-sidebar-candidate=\"/fixture/repo/linked\"]')",
  );
  click("button[data-project-sidebar-candidate='/fixture/repo/linked']");
  await waitForBodyText("Orca UI");
  await waitFor(
    "Project workspace references",
    "document.querySelector('[data-project-sidebar-project]') && document.querySelector('[data-project-sidebar-legacy-compat]:not([open])')",
  );
  const completedAdoption = counters();
  const projectId = completedAdoption.createProjectIds[0];
  if (!projectId) throw new Error("retry did not retain the Project identity");
  const workspaceReferencesBeforeReuse = fixtureApi(
    `getCatalogWorkspaceReferenceCount(${JSON.stringify(projectId)})`,
  );
  assertStep(
    completedAdoption.createProjectCalls === 2 &&
      completedAdoption.adoptionCalls === 1 &&
      completedAdoption.workspaceRefWrites === 0 &&
      completedAdoption.createProjectIds[0] === completedAdoption.createProjectIds[1],
    "retry reuses the same Project/workspace IDs and commits its first Catalog write with the workspace reference",
  );

  fill("input[aria-label='Project name']", "Existing binding reuse");
  fill("input[aria-label='Worktree path']", "/fixture/repo/bare");
  click("form[data-project-sidebar-add-form] button[type='submit']");
  await waitFor(
    "bare repository linked candidates identify their owner",
    "document.querySelector('[data-project-sidebar-candidate=\"/fixture/repo/linked/bare-discovered\"]')?.innerText.includes('Add to Orca UI')",
  );
  click("button[data-fixture-action='fail-next-reference']");
  const createsBeforeReuse = counters().createProjectCalls;
  click("button[data-project-sidebar-candidate='/fixture/repo/linked/bare-discovered']");
  await waitForBodyText("fixture-catalog-reference-write-failed");
  const failedExistingReference = counters();
  const workspaceReferencesAfterFailure = fixtureApi(
    `getCatalogWorkspaceReferenceCount(${JSON.stringify(projectId)})`,
  );
  assertStep(
    failedExistingReference.createProjectCalls === createsBeforeReuse &&
      failedExistingReference.adoptionCalls === 2 &&
      failedExistingReference.workspaceRefWrites === 0 &&
      workspaceReferencesAfterFailure === workspaceReferencesBeforeReuse,
    "adding a new bare-repository linked candidate reuses its current Project and preserves retry state after refs fail",
  );
  pageValue(
    `(() => { const button = document.querySelector('[data-project-sidebar-candidate="/fixture/repo/linked/bare-discovered"]'); if (!button) return false; button.scrollIntoView({ block: 'center' }); return true; })()`,
  );
  await waitFor(
    "existing binding candidate ready for reference retry",
    "Boolean(document.querySelector('[data-project-sidebar-candidate=\"/fixture/repo/linked/bare-discovered\"]') && !document.querySelector('[data-project-sidebar-candidate=\"/fixture/repo/linked/bare-discovered\"]').disabled)",
  );
  click("button[data-project-sidebar-candidate='/fixture/repo/linked/bare-discovered']");
  await waitFor(
    "existing Project Catalog reference restored",
    `window.__projectSidebarFixture.getCatalogWorkspaceReferenceCount(${JSON.stringify(projectId)}) === ${workspaceReferencesBeforeReuse + 1}`,
  );
  const completedExistingReference = counters();
  const workspaceReferencesAfterRetry = fixtureApi(
    `getCatalogWorkspaceReferenceCount(${JSON.stringify(projectId)})`,
  );
  assertStep(
    completedExistingReference.createProjectCalls === createsBeforeReuse &&
      completedExistingReference.adoptionCalls === 2 &&
      completedExistingReference.workspaceRefWrites === 0 &&
      workspaceReferencesAfterRetry === workspaceReferencesBeforeReuse + 1,
    "retry finishes only the existing Project reference; it does not recreate or move the Project",
  );
  if (pageValue("Boolean(document.querySelector('[data-project-sidebar-add-form]'))")) {
    scrollAddProjectIntoView();
    click("button[data-project-sidebar-add-project='true']");
  }
  await waitFor(
    "Project management form is closed before workspace creation",
    "!document.querySelector('[data-project-sidebar-add-form]')",
  );
  await waitFor(
    "existing Project remains registered",
    "window.__projectSidebarFixture.getCatalogProjectIds().length === 1 && document.querySelector('[data-project-sidebar-project]')",
  );

  click(`button[aria-label='Add a workspace to Orca UI']`);
  browser("check", "input[value='existing-branch']");
  await waitFor(
    "existing branch mode",
    "document.querySelector('input[aria-label=\"Existing branch\"]')",
  );
  fill("input[aria-label='Workspace title']", "Branch recovery");
  fill("input[aria-label='New worktree path']", "/fixture/repo/linked/recovery");
  fill("input[aria-label='Existing branch']", "release-candidate");
  click(`form[data-project-sidebar-workspace-form='${projectId}'] button[type='submit']`);
  await waitForBodyText("This worktree exists but is not registered.");
  const firstCreate = counters().createWorkspaceCalls;
  assertStep(
    firstCreate.length === 1 && firstCreate[0].mode === "existing-branch",
    "workspace creation sends the explicit existing-branch request and shows its recovery candidate",
  );
  const firstRequestId = firstCreate[0].requestId;
  assertStep(
    pageValue("document.body.innerText.includes('/fixture/repo/linked/recovery')"),
    "unregistered worktree candidate is visible with an explicit adoption action",
  );
  const retryButtonState = pageValue(`JSON.stringify({
    busy: document.querySelector('[data-project-sidebar-workspace-form]')?.getAttribute('aria-busy'),
    disabled: document.querySelector('[data-project-sidebar-retry-registration="true"]')?.disabled,
    label: document.querySelector('[data-project-sidebar-retry-registration="true"]')?.innerText
  })`);
  record(`workspace retry button state: ${JSON.stringify(retryButtonState)}`);
  assertStep(
    retryButtonState.busy === "false" && retryButtonState.disabled === false,
    "unregistered create exposes an enabled explicit adoption action",
  );
  const projectDefaultBeforeRecovery = fixtureApi(
    `getCatalogProjects().find((project) => project.id === ${JSON.stringify(projectId)})?.defaultWorkspaceId`,
  );
  const adoptionCallsBeforeRecovery = counters().adoptionCalls;
  const referenceWritesBeforeRecovery = counters().workspaceRefWrites;
  browser("find", "role", "button", "click", "--name", "Adopt existing worktree", "--exact");
  await waitFor(
    "explicit workspace recovery reaches WorktreeService adopt",
    `window.__projectSidebarFixture.counters().adoptionCalls === ${adoptionCallsBeforeRecovery + 1} && window.__projectSidebarFixture.counters().createWorkspaceCalls.length === 1`,
  );
  record(`workspace recovery counters: ${JSON.stringify(counters())}`);
  await waitFor(
    "workspace recovery closes the form",
    "!document.querySelector('[data-project-sidebar-workspace-form]')",
  );
  const recoveredCreate = counters().createWorkspaceCalls;
  const recoveredWorkspace = fixtureApi("getWorktreeRecords()").filter(
    (workspace) => workspace.worktreePath === "/fixture/repo/linked/recovery",
  );
  const projectAfterRecovery = fixtureApi(
    `getCatalogProjects().find((project) => project.id === ${JSON.stringify(projectId)})`,
  );
  assertStep(
    recoveredCreate.length === 1 &&
      recoveredCreate[0].requestId === firstRequestId &&
      recoveredWorkspace.length === 1 &&
      recoveredWorkspace[0].head.ref === "release-candidate" &&
      recoveredWorkspace[0].title === "Branch recovery" &&
      counters().workspaceRefWrites === referenceWritesBeforeRecovery &&
      projectAfterRecovery.workspaceReferences.some(
        (reference) => reference.workspaceId === recoveredWorkspace[0].id,
      ) &&
      projectAfterRecovery.defaultWorkspaceId === projectDefaultBeforeRecovery,
    "explicit recovery adopts the same path and branch once, repairs refs and preserves Project default without another create",
  );

  click(`button[aria-label='Add a workspace to Orca UI']`);
  fill("input[aria-label='Workspace title']", "New branch workspace");
  fill("input[aria-label='New worktree path']", "/fixture/repo/linked/new-branch");
  fill("input[aria-label='Base ref']", "feature/ui");
  fill("input[aria-label='New branch']", "feature/with-space");
  assertStep(
    pageValue(
      "document.querySelector('input[value=\"new-branch\"]')?.checked === true && document.querySelector('input[aria-label=\"Base ref\"]') !== null",
    ),
    "new-branch mode explicitly collects its base ref and branch name",
  );
  click(`form[data-project-sidebar-workspace-form='${projectId}'] button[type='submit']`);
  await waitFor(
    "new branch workspace creation",
    "!document.querySelector('[data-project-sidebar-workspace-form]')",
  );
  const bothCreateModes = counters().createWorkspaceCalls;
  assertStep(
    bothCreateModes.length === 2 &&
      bothCreateModes[1].mode === "new-branch" &&
      bothCreateModes[1].baseRef === "feature/ui" &&
      bothCreateModes[1].newBranch === "feature/with-space",
    "strict Worktree port receives the explicit new-branch payload",
  );

  click(`button[aria-label='Add a workspace to Orca UI']`);
  browser("check", "input[value='existing-branch']");
  fill("input[aria-label='Workspace title']", "Missing candidate recovery");
  fill("input[aria-label='New worktree path']", "/fixture/repo/linked/missing-candidate");
  fill("input[aria-label='Existing branch']", "release-candidate");
  click("button[data-fixture-action='fail-create-without-candidate']");
  click(`form[data-project-sidebar-workspace-form='${projectId}'] button[type='submit']`);
  await waitForBodyText("Git created the worktree, but no candidate was returned.");
  const noCandidateCreate = counters().createWorkspaceCalls;
  assertStep(
    noCandidateCreate.length === 3 &&
      noCandidateCreate[2].worktreePath === "/fixture/repo/linked/missing-candidate" &&
      !pageValue("document.querySelector('[data-project-sidebar-retry-registration]')") &&
      pageValue("document.body.innerText.includes('explicitly select this existing path')"),
    "missing candidate shows a recoverable instruction and blocks a blind create retry",
  );
  click(`form[data-project-sidebar-workspace-form='${projectId}'] button:last-child`);
  scrollAddProjectIntoView();
  click("button[data-project-sidebar-add-project='true']");
  fill("input[aria-label='Project name']", "Explicit missing-candidate recovery");
  fill("input[aria-label='Worktree path']", "/fixture/repo/linked/missing-candidate");
  click("form[data-project-sidebar-add-form] button[type='submit']");
  await waitFor(
    "read-only discovery exposes the unresolved candidate for explicit selection",
    "document.querySelector('button[data-project-sidebar-candidate=\"/fixture/repo/linked/missing-candidate\"]')",
  );
  const adoptionsBeforeMissingCandidateSelection = counters().adoptionCalls;
  assertStep(
    counters().createProjectCalls === completedExistingReference.createProjectCalls &&
      counters().adoptionCalls === adoptionsBeforeMissingCandidateSelection &&
      pageValue("document.querySelectorAll('[data-project-sidebar-candidate]').length") > 1,
    "read-only rediscovery offers multiple candidates without selecting or adopting one implicitly",
  );
  click("button[data-project-sidebar-candidate='/fixture/repo/linked/missing-candidate']");
  await waitFor(
    "explicit candidate selection completes missing-candidate recovery",
    `window.__projectSidebarFixture.getWorktreeRecords().some((workspace) => workspace.worktreePath === "/fixture/repo/linked/missing-candidate") && window.__projectSidebarFixture.counters().adoptionCalls === ${adoptionsBeforeMissingCandidateSelection + 1}`,
  );
  if (pageValue("Boolean(document.querySelector('[data-project-sidebar-add-form]'))")) {
    scrollAddProjectIntoView();
    click("button[data-project-sidebar-add-project='true']");
  }
  await waitFor(
    "Project management form closes after explicit missing-candidate recovery",
    "!document.querySelector('[data-project-sidebar-add-form]')",
  );

  click("button[data-fixture-action='install-hierarchy']");
  click("button[aria-label='Refresh project workspaces']");
  await waitFor(
    "two-Project hierarchy fixture",
    "document.querySelectorAll('[data-project-sidebar-project]').length === 2",
  );
  const allProjectIds = pageValue(
    "[...document.querySelectorAll('[data-project-sidebar-project]')].map(project => project.getAttribute('data-project-sidebar-project'))",
  );
  const fullFixtureProjectId = allProjectIds[0];
  const secondProjectId = allProjectIds[1];
  browser(
    "scrollintoview",
    `button[data-project-sidebar-project-toggle='${fullFixtureProjectId}']`,
  );
  click(`button[data-project-sidebar-project-toggle='${fullFixtureProjectId}']`);
  await waitFor(
    `expanded Project ${fullFixtureProjectId}`,
    `window.__projectSidebarFixture.getViewState().expandedProjectIds.includes(${JSON.stringify(fullFixtureProjectId)})`,
  );
  const firstProjectWorkspaceIds = pageValue(
    `([...document.querySelectorAll("div[data-project-sidebar-project='${fullFixtureProjectId}'] [data-project-sidebar-workspace]")]).map(workspace => workspace.getAttribute('data-project-sidebar-workspace'))`,
  );
  assertStep(
    firstProjectWorkspaceIds.includes("one-main") &&
      firstProjectWorkspaceIds.includes("one-linked") &&
      firstProjectWorkspaceIds.includes("workspace-fixture-repo-linked") &&
      firstProjectWorkspaceIds.includes("workspace-fixture-repo-linked-bare-discovered") &&
      firstProjectWorkspaceIds.includes("workspace-fixture-repo-linked-recovery") &&
      firstProjectWorkspaceIds.some((id) => id.startsWith("workspace-created-workspace-")) &&
      firstProjectWorkspaceIds.includes("workspace-fixture-repo-linked-missing-candidate"),
    "first Project keeps legacy main/linked rows and every discovered, created, and recovered Workspace",
  );
  click("div[data-project-sidebar-workspace='one-linked'] button[aria-expanded]");
  const selectionBeforeSecondProjectAttention = fixtureApi("getViewState()");
  browser("scrollintoview", `button[data-project-sidebar-attention='${secondProjectId}']`);
  browser(
    "find",
    "role",
    "button",
    "click",
    "--name",
    "Show attention for Second Project (1)",
    "--exact",
  );
  await waitFor(
    "collapsed Project expands in the view store",
    `window.__projectSidebarFixture.getViewState().expandedProjectIds.includes(${JSON.stringify(secondProjectId)})`,
  );
  await waitFor(
    "pending workspace expands in the view store",
    `window.__projectSidebarFixture.getViewState().expandedWorkspaceKeys.includes(${JSON.stringify(JSON.stringify(["fixture-target", "two-detached"]))})`,
  );
  await waitFor(
    "second Project attention reveals its pending detached worktree",
    "document.querySelector('[data-project-sidebar-workspace=\"two-detached\"]')",
  );
  assertStep(
    JSON.stringify(
      ((state) => ({
        activeProjectId: state.activeProjectId,
        activeWorkspaceKey: state.activeWorkspaceKey,
        activeSessionKey: state.activeSessionKey,
      }))(fixtureApi("getViewState()")),
    ) ===
      JSON.stringify(
        ((state) => ({
          activeProjectId: state.activeProjectId,
          activeWorkspaceKey: state.activeWorkspaceKey,
          activeSessionKey: state.activeSessionKey,
        }))(selectionBeforeSecondProjectAttention),
      ),
    "Project attention entry expands and reveals a hidden Project without changing active selection",
  );
  await waitFor(
    "all Project workspaces expanded",
    "document.querySelectorAll('[data-project-sidebar-workspace]').length >= 5",
  );
  await waitFor(
    "all hierarchy session rows mounted",
    "document.querySelectorAll('[data-project-sidebar-session]').length === 4",
  );
  assertStep(
    pageValue("document.querySelectorAll('[data-project-sidebar-session]').length") === 4,
    "fixture renders two Projects, eight Workspaces and four sessions including two Pi sessions in one workspace",
  );
  assertStep(
    pageValue(
      "!document.querySelector('[data-legacy-task=\"native-session\"]') && Boolean(document.querySelector('[data-legacy-task=\"legacy-only-task\"]'))",
    ),
    "mixed compatibility history keeps an unmapped legacy task reachable without duplicating the mapped native session",
  );
  await waitFor(
    "non-Git session verification entry",
    "document.querySelector('[data-project-sidebar-unverified-session=\"legacy-non-git-session\"]')",
  );
  click("[data-project-sidebar-unverified-session='legacy-non-git-session']");
  await waitFor(
    "non-Git history opens the legacy view",
    "document.querySelector('details[data-project-sidebar-legacy-compat]')?.open === true && document.querySelector('[data-legacy-task=\"legacy-only-task\"]')",
  );
  assertStep(
    pageValue(
      "document.querySelector('[data-project-sidebar-unverified-session=\"legacy-non-git-session\"]') !== null",
    ),
    "unverified non-Git history has a history-only entry and remains separate from execution rows",
  );
  assertStep(
    ["Main checkout", "feature/ui", "Detached HEAD", "live"].every((text) =>
      pageValue(`document.body.innerText.includes(${JSON.stringify(text)})`),
    ),
    "sidebar shows the main checkout, branch and detached HEAD labels with target freshness",
  );
  assertStep(
    pageValue(
      "[...document.querySelectorAll('[data-project-sidebar-session]')].some(row => row.textContent.includes('Native task: preserve subdirectory'))",
    ),
    "native session row uses the persisted task title and summary timestamp source",
  );
  assertStep(
    pageValue(
      "document.querySelector('button[data-project-sidebar-session=\"native-session\"] time') !== null",
    ),
    "session rows display their last update time",
  );
  if (
    !pageValue(
      `document.querySelector("button[data-project-sidebar-project-toggle='${fullFixtureProjectId}']")?.getAttribute('aria-expanded') === 'true'`,
    )
  ) {
    click(`button[data-project-sidebar-project-toggle='${fullFixtureProjectId}']`);
  }
  if (
    !pageValue(
      "document.querySelector('div[data-project-sidebar-workspace=\"one-linked\"] button[aria-expanded]')?.getAttribute('aria-expanded') === 'true'",
    )
  ) {
    click("div[data-project-sidebar-workspace='one-linked'] button[aria-expanded]");
  }
  click("div[data-project-sidebar-workspace='one-linked'] button[aria-label^='Hide ']");
  await waitFor(
    "hidden pending workspace attention row",
    "document.querySelector('[data-project-sidebar-hidden-workspace=\"one-linked\"]')",
  );
  const hiddenCount = pageValue(
    `document.querySelector("[data-project-sidebar-project='${fullFixtureProjectId}']")?.innerText`,
  );
  assertStep(
    String(hiddenCount).includes("3"),
    "hidden workspace sessions still contribute to Project counts",
  );
  click(`button[data-project-sidebar-project-toggle='${fullFixtureProjectId}']`);
  const selectedBeforeReveal = fixtureApi("getViewState()");
  browser("find", "role", "button", "click", "--name", "Show attention for Orca UI (1)", "--exact");
  await waitFor(
    "Project attention reveals and expands the hidden workspace",
    "document.querySelector('[data-project-sidebar-workspace=\"one-linked\"]') && !document.querySelector('[data-project-sidebar-hidden-workspace=\"one-linked\"]')",
  );
  assertStep(
    JSON.stringify(
      ((state) => ({
        activeProjectId: state.activeProjectId,
        activeWorkspaceKey: state.activeWorkspaceKey,
        activeSessionKey: state.activeSessionKey,
      }))(fixtureApi("getViewState()")),
    ) ===
      JSON.stringify(
        ((state) => ({
          activeProjectId: state.activeProjectId,
          activeWorkspaceKey: state.activeWorkspaceKey,
          activeSessionKey: state.activeSessionKey,
        }))(selectedBeforeReveal),
      ),
    "attention reveal changes only window view state and preserves active selection",
  );

  click("button[data-project-sidebar-session='native-session']");
  const selectedSession = fixtureApi("getViewState()");
  assertStep(
    selectedSession.activeSessionKey ===
      JSON.stringify(["fixture-target", "one-linked", "native-session"]),
    "foreground native selection routes through its mapped session ID",
  );
  assertStep(
    pageValue(
      "document.querySelector('button[data-project-sidebar-session=\"pi-review\"]')?.disabled === false",
    ),
    "external Pi row remains selectable through the existing owner-routing callback",
  );

  scrollAddProjectIntoView();
  click("button[data-project-sidebar-add-project='true']");
}
