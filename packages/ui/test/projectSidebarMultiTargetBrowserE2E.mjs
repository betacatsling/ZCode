/* eslint-disable max-lines -- This end-to-end scenario verifies cross-target UI behavior against real file-backed Catalog and Git owners. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  createWriteStream,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const root = process.cwd();
const outputDirectory =
  process.env.PROJECT_SIDEBAR_MULTITARGET_E2E_OUTPUT_DIR ??
  "/tmp/zcode-gpt6-multitarget-ui/browser-real";
const agentBrowser = process.env.AGENT_BROWSER_BIN;
const chrome = process.env.CHROME_BIN;
const fixedBin = "/tmp/zcode-toolchain.E7bW9N/node_modules/.bin";
const gitBin = "/tmp/catalog-fix-tools/git-2.45.4";
const pathEnvironment = `${gitBin}:${fixedBin}:${process.env.PATH ?? ""}`;

async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate test port");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

if (!agentBrowser || !existsSync(agentBrowser))
  throw new Error("Set AGENT_BROWSER_BIN to agent-browser");
if (!chrome || !existsSync(chrome))
  throw new Error("Set CHROME_BIN to a local Chrome/Chromium executable");
mkdirSync(outputDirectory, { recursive: true });

const vitePort = await allocatePort();
const servicePort = await allocatePort();
const cdpPort = await allocatePort();
const runId = `${Date.now()}-${process.pid}`;
const driverLogPath = join(outputDirectory, "node-service-driver.log");
const viteLogPath = join(outputDirectory, "vite.log");
const chromeLogPath = join(outputDirectory, "chrome.log");
const runLogPath = join(outputDirectory, "multitarget-e2e.log");
const reportPath = join(outputDirectory, "multitarget-e2e-report.json");
const screenshotPaths = {
  samePath: join(outputDirectory, "same-path-two-targets.png"),
  offline: join(outputDirectory, "target-alpha-offline-target-beta-live.png"),
  bare: join(outputDirectory, "bare-repository-import.png"),
  mobile: join(outputDirectory, "mobile-multi-target-sidebar.png"),
};
const browserDirectory = join(outputDirectory, `browser-${runId}`);
const chromeProfile = join(outputDirectory, `chrome-profile-${runId}`);
mkdirSync(browserDirectory, { recursive: true });
const chromeEnvironment = {
  ...process.env,
  PATH: pathEnvironment,
  AGENT_BROWSER_SOCKET_DIR: join(outputDirectory, `sockets-${runId}`),
  AGENT_BROWSER_PROFILE: browserDirectory,
  AGENT_BROWSER_EXECUTABLE_PATH: chrome,
  AGENT_BROWSER_DEFAULT_TIMEOUT: process.env.AGENT_BROWSER_DEFAULT_TIMEOUT ?? "60000",
  AGENT_BROWSER_SCREENSHOT_DIR: outputDirectory,
  XDG_CACHE_HOME: join(outputDirectory, "cache"),
  XDG_CONFIG_HOME: join(outputDirectory, "chrome-config"),
  XDG_DATA_HOME: join(outputDirectory, "chrome-data"),
};
for (const path of [
  chromeEnvironment.AGENT_BROWSER_SOCKET_DIR,
  chromeEnvironment.XDG_CACHE_HOME,
  chromeEnvironment.XDG_CONFIG_HOME,
  chromeEnvironment.XDG_DATA_HOME,
]) {
  mkdirSync(path, { recursive: true });
}

const driver = spawn(
  process.execPath,
  [
    join(root, "node_modules/tsx/dist/cli.mjs"),
    "packages/ui/test/fixtures/projectSidebarMultiTargetNodeDriver.ts",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PATH: pathEnvironment,
      PROJECT_SIDEBAR_DRIVER_PORT: String(servicePort),
      PROJECT_SIDEBAR_REAL_DATA_DIR: outputDirectory,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const vite = spawn(
  process.execPath,
  [
    join(root, "node_modules/vite/bin/vite.js"),
    "--config",
    "packages/ui/test/fixtures/projectSidebarBrowser.vite.config.ts",
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PATH: pathEnvironment,
      SIDEBAR_FIXTURE_PORT: String(vitePort),
      PROJECT_SIDEBAR_DRIVER_PORT: String(servicePort),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
const chromeProcess = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeProfile}`,
    `http://127.0.0.1:${vitePort}/projectSidebarMultiTargetBrowser.html`,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      PATH: pathEnvironment,
      XDG_CACHE_HOME: chromeEnvironment.XDG_CACHE_HOME,
      XDG_CONFIG_HOME: chromeEnvironment.XDG_CONFIG_HOME,
      XDG_DATA_HOME: chromeEnvironment.XDG_DATA_HOME,
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

for (const [child, path] of [
  [driver, driverLogPath],
  [vite, viteLogPath],
  [chromeProcess, chromeLogPath],
]) {
  child.stdout.pipe(createWriteStream(path, { flags: "a" }));
  child.stderr.pipe(createWriteStream(path, { flags: "a" }));
}

const steps = [];
const screenshotFiles = {};
function record(message) {
  steps.push({ at: new Date().toISOString(), message });
  appendFileSync(runLogPath, `${new Date().toISOString()} ${message}\n`);
}

function browser(...args) {
  const command = ["--cdp", String(cdpPort), ...args];
  const output = execFileSync(agentBrowser, command, {
    encoding: "utf8",
    timeout: Number(process.env.AGENT_BROWSER_COMMAND_TIMEOUT_MS ?? 60_000),
    env: chromeEnvironment,
  });
  appendFileSync(runLogPath, `$ agent-browser ${command.join(" ")}\n${output}\n`);
  return output.trim();
}

function pageValue(expression) {
  const output = browser("eval", expression);
  try {
    const value = JSON.parse(output);
    if (typeof value !== "string") return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  } catch {
    return output;
  }
}

async function driverState() {
  const response = await fetch(`http://127.0.0.1:${servicePort}/__project-sidebar/state`);
  if (!response.ok) throw new Error(`Driver state failed with HTTP ${response.status}`);
  return response.json();
}

async function waitForDriver(label, predicate, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await driverState();
    if (predicate(value)) return value;
    await sleep(100);
  }
  throw new Error(`Timed out waiting for driver ${label}`);
}

async function waitFor(label, expression, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      if (pageValue(`Boolean(${expression})`) === true) return;
    } catch {
      // The fixture may be between a page reload and React mount.
    }
    await sleep(200);
  }
  throw new Error(
    `Timed out waiting for ${label}: ${String(pageValue("document.body?.innerText ?? ''")).slice(0, 1000)}`,
  );
}

async function waitForText(text, timeout = 30_000) {
  await waitFor(
    `body text ${text}`,
    `document.body?.innerText.includes(${JSON.stringify(text)})`,
    timeout,
  );
}

function click(selector) {
  browser("click", selector);
}

function fill(selector, value) {
  browser("fill", selector, value);
}

function selectValue(selector, value) {
  const expression = `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error("missing select: " + ${JSON.stringify(selector)}); node.value = ${JSON.stringify(value)}; node.dispatchEvent(new Event("change", { bubbles: true })); return node.value === ${JSON.stringify(value)}; })()`;
  assert.equal(pageValue(expression), true, `Selected ${value} in ${selector}`);
}

function scrollIntoView(selector) {
  const expression = `(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.scrollIntoView({ block: "center", inline: "nearest" }); return true; })()`;
  assert.equal(pageValue(expression), true, `Scrolled ${selector} into view`);
}

function screenshot(name, path) {
  browser("screenshot", path);
  assert.ok(existsSync(path), `Screenshot should exist: ${path}`);
  screenshotFiles[name] = path;
  record(`captured ${name}: ${path}`);
}

function assertStep(condition, message) {
  assert.ok(condition, message);
  record(`PASS ${message}`);
}

async function waitForServer(url, label) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json().catch(() => ({}));
    } catch {
      // Service is starting.
    }
    await sleep(200);
  }
  throw new Error(`${label} did not start`);
}

async function driverControl(path, payload) {
  const response = await fetch(`http://127.0.0.1:${servicePort}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? `Driver control failed: ${path}`);
  return result;
}

async function stopProcessGroup(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(resolve, 5000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

let report;
try {
  const health = await waitForServer(
    `http://127.0.0.1:${servicePort}/__project-sidebar/health`,
    "real file-backed service driver",
  );
  await waitForServer(
    `http://127.0.0.1:${vitePort}/projectSidebarMultiTargetBrowser.html`,
    "Vite browser fixture",
  );
  await waitForServer(`http://127.0.0.1:${cdpPort}/json/version`, "Chrome CDP");
  record(`started real service ports at ${health.root}; ${health.gitVersion}`);
  await waitFor(
    "multi-target sidebar mount",
    "window.__projectSidebarMultiTarget && document.querySelector('[data-project-sidebar]')",
  );
  record(
    `registered attachments: ${JSON.stringify(pageValue("JSON.stringify(window.__projectSidebarMultiTarget.attachments())"))}`,
  );

  const targetAlpha = health.targetIds[0];
  const targetBeta = health.targetIds[1];
  const targetGamma = health.targetIds[2];
  const targetDelta = health.targetIds[3];
  const projectName = "Shared target project";
  const importProject = async ({
    targetId,
    existingProjectId,
    name,
    path,
    deferSelection = false,
    deferBareAdoption = false,
  }) => {
    if (!pageValue("Boolean(document.querySelector('[data-project-sidebar-add-form]'))")) {
      click("button[data-project-sidebar-add-project='true']");
    }
    await waitFor(
      "Project import form",
      "document.querySelector('[data-project-sidebar-add-form]')",
    );
    await waitFor(
      `connected target option ${targetId}`,
      `Array.from(document.querySelector("select[aria-label='Target']")?.options ?? []).some((option) => option.value === ${JSON.stringify(targetId)})`,
    );
    selectValue("select[aria-label='Target']", targetId);
    selectValue("select[aria-label='Project']", existingProjectId ?? "");
    if (!existingProjectId) fill("input[aria-label='Project name']", name);
    fill("input[aria-label='Worktree path']", path);
    click("form[data-project-sidebar-add-form] button[type='submit']");
    await waitFor(
      "worktree candidates",
      `document.querySelector('[data-project-sidebar-candidate=${JSON.stringify(path)}]') || document.body.innerText.includes('bare repository')`,
    );
    if (
      pageValue(
        `Boolean(document.querySelector('[data-project-sidebar-candidate=${JSON.stringify(path)}]'))`,
      )
    ) {
      if (deferSelection) return;
      click(`button[data-project-sidebar-candidate=${JSON.stringify(path)}]`);
    } else {
      await waitForText("bare repository");
      if (deferBareAdoption) return;
      click("button[data-project-sidebar-add-bare='true']");
    }
  };

  await importProject({
    targetId: targetAlpha,
    name: projectName,
    path: health.repoPath,
  });
  await waitForText(projectName);
  let state = await driverState();
  const project = state.catalog.projects.find((item) => item.name === projectName);
  assert.ok(project, "new Project is persisted by the file-backed Catalog service");
  const projectToggle = `button[data-project-sidebar-project-toggle=${JSON.stringify(project.id)}]`;
  if (
    pageValue(
      `document.querySelector(${JSON.stringify(projectToggle)})?.getAttribute('aria-expanded') !== 'true'`,
    )
  ) {
    click(projectToggle);
  }
  await waitFor(
    "alpha worktree row",
    `document.querySelector('[data-project-sidebar-workspace=${JSON.stringify(project.defaultWorkspaceId)}][data-project-sidebar-target=${JSON.stringify(targetAlpha)}]')`,
  );
  record(
    `post-import attachments: ${JSON.stringify(pageValue("JSON.stringify(window.__projectSidebarMultiTarget.attachments())"))}; target reads: ${JSON.stringify((await driverState()).counters.worktreeReadsByTarget)}`,
  );
  const defaultWorkspaceId = project.defaultWorkspaceId;
  assert.equal(project.defaultWorkspaceTargetId, targetAlpha);
  assert.equal(project.workspaceReferences.length, 1);
  assert.equal(project.workspaceReferences[0].targetId, targetAlpha);
  record(`created Project ${project.id} with the actual file-backed target-A reference`);

  await importProject({
    targetId: targetBeta,
    existingProjectId: project.id,
    path: health.repoPath,
  });
  state = await waitForDriver(
    "same scoped workspace id in both Worktree files",
    (value) =>
      value.worktrees[targetAlpha].workspaces.length === 1 &&
      value.worktrees[targetBeta].workspaces.length === 1 &&
      value.worktrees[targetAlpha].workspaces[0].id ===
        value.worktrees[targetBeta].workspaces[0].id,
  );
  const sharedWorkspaceId = state.worktrees[targetAlpha].workspaces[0].id;
  await waitFor(
    "target-scoped duplicate workspace rows",
    `document.querySelectorAll('[data-project-sidebar-workspace=${JSON.stringify(sharedWorkspaceId)}]').length === 2`,
  );
  state = await driverState();
  const persistedProject = state.catalog.projects.find((item) => item.id === project.id);
  assert.equal(persistedProject.workspaceReferences.length, 2);
  assert.deepEqual(
    persistedProject.workspaceReferences.map((reference) => reference.targetId).sort(),
    [targetAlpha, targetBeta].sort(),
  );
  assert.equal(persistedProject.defaultWorkspaceId, defaultWorkspaceId);
  assert.equal(persistedProject.defaultWorkspaceTargetId, targetAlpha);
  assertStep(
    pageValue(
      `document.querySelectorAll('[data-project-sidebar-workspace=${JSON.stringify(sharedWorkspaceId)}]').length === 2 && Boolean(document.querySelector('[data-project-sidebar-workspace=${JSON.stringify(sharedWorkspaceId)}][data-project-sidebar-target=${JSON.stringify(targetAlpha)}]')) && Boolean(document.querySelector('[data-project-sidebar-workspace=${JSON.stringify(sharedWorkspaceId)}][data-project-sidebar-target=${JSON.stringify(targetBeta)}]'))`,
    ),
    "actual React tree keeps identical path/workspace IDs separate by target",
  );
  screenshot("samePath", screenshotPaths.samePath);

  const alphaRow = `[data-project-sidebar-workspace=${JSON.stringify(sharedWorkspaceId)}][data-project-sidebar-target=${JSON.stringify(targetAlpha)}]`;
  const betaRow = `[data-project-sidebar-workspace=${JSON.stringify(sharedWorkspaceId)}][data-project-sidebar-target=${JSON.stringify(targetBeta)}]`;
  const alphaToggle = `${alphaRow} button[aria-expanded]`;
  const betaToggle = `${betaRow} button[aria-expanded]`;
  click(alphaToggle);
  assertStep(
    pageValue(
      `document.querySelector(${JSON.stringify(alphaToggle)})?.getAttribute('aria-expanded') === 'true' && document.querySelector(${JSON.stringify(betaToggle)})?.getAttribute('aria-expanded') === 'false'`,
    ),
    "workspace expansion is scoped by target even when the workspace ID matches",
  );
  const alphaKey = JSON.stringify([targetAlpha, sharedWorkspaceId]);
  assert.ok(
    pageValue(
      `window.__projectSidebarMultiTarget.viewState().expandedWorkspaceKeys.includes(${JSON.stringify(alphaKey)})`,
    ),
  );
  click(betaToggle);
  assert.ok(
    pageValue(
      `window.__projectSidebarMultiTarget.viewState().expandedWorkspaceKeys.includes(${JSON.stringify(JSON.stringify([targetBeta, sharedWorkspaceId]))})`,
    ),
  );
  const defaultMarkers = pageValue(
    `JSON.stringify({ alpha: document.querySelector(${JSON.stringify(alphaRow)})?.innerText.includes('default'), beta: document.querySelector(${JSON.stringify(betaRow)})?.innerText.includes('default') })`,
  );
  assert.equal(defaultMarkers.alpha, true);
  assert.equal(defaultMarkers.beta, false);
  click(`${alphaRow} button[aria-label^='Hide ']`);
  assertStep(
    pageValue(
      `!document.querySelector(${JSON.stringify(alphaRow)}) && Boolean(document.querySelector(${JSON.stringify(betaRow)})) && window.__projectSidebarMultiTarget.viewState().hiddenWorkspaceKeys.includes(${JSON.stringify(alphaKey)})`,
    ),
    "hiding one target's workspace leaves the matching ID on the other target visible",
  );
  await pageValue(
    `window.__projectSidebarMultiTarget.showWorkspace(${JSON.stringify(targetAlpha)}, ${JSON.stringify(sharedWorkspaceId)}); true`,
  );
  click("button[aria-label='Refresh project workspaces']");
  await waitFor("restored alpha workspace", `document.querySelector(${JSON.stringify(alphaRow)})`);

  await pageValue(
    `window.__projectSidebarMultiTarget.seedSessions(${JSON.stringify(project.id)}, 'same-session').then(() => true)`,
  );
  click("button[aria-label='Refresh project workspaces']");
  await waitFor(
    "two target-scoped session rows",
    `document.querySelector('[data-project-sidebar-session="same-session"][data-project-sidebar-target=${JSON.stringify(targetAlpha)}]') && document.querySelector('[data-project-sidebar-session="same-session"][data-project-sidebar-target=${JSON.stringify(targetBeta)}]')`,
  );
  await waitFor(
    "same-target non-Git history-only entry",
    `document.querySelector('[data-project-sidebar-unverified-session=${JSON.stringify(`legacy-non-git-${targetAlpha}`)}]')`,
  );
  click(
    `[data-project-sidebar-unverified-session=${JSON.stringify(`legacy-non-git-${targetAlpha}`)}]`,
  );
  assertStep(
    pageValue(
      "document.querySelector('details[data-project-sidebar-legacy-compat]')?.open === true && document.body.innerText.includes('Non-Git legacy task history')",
    ),
    "pending non-Git history is exposed through a history-only action rather than a Project execution route",
  );
  if (
    pageValue(
      `document.querySelector(${JSON.stringify(betaToggle)})?.getAttribute('aria-expanded') !== 'true'`,
    )
  ) {
    click(betaToggle);
  }
  const betaSessionSelector = `button[data-project-sidebar-session='same-session'][data-project-sidebar-target=${JSON.stringify(targetBeta)}]`;
  scrollIntoView(betaSessionSelector);
  click(betaSessionSelector);
  await waitFor(
    "external session route uses the Beta attachment",
    `window.__projectSidebarMultiTarget.selectedRoutes().some((route) => route.kind === 'agent-host' && route.targetId === ${JSON.stringify(targetBeta)} && route.remoteSessionId === 'sidebar-attachment-${targetBeta}-1')`,
  );
  assertStep(
    pageValue(
      `window.__projectSidebarMultiTarget.selectedRoutes().at(-1)?.remoteSessionId === 'sidebar-attachment-${targetBeta}-1'`,
    ),
    "session routing carries the current target attachment instead of matching path or workspace ID",
  );

  await pageValue(
    `window.__projectSidebarMultiTarget.setHostUnsupported(${JSON.stringify(targetBeta)}, true).then(() => true)`,
  );
  click("button[aria-label='Refresh project workspaces']");
  await waitFor(
    "mixed modern tree and legacy target snapshot",
    `document.querySelector(${JSON.stringify(alphaRow)})?.innerText.includes('live') && document.querySelector(${JSON.stringify(betaRow)})?.innerText.includes('stale')`,
  );
  assert.equal(
    pageValue(
      `document.querySelector('[data-project-sidebar-session="same-session"][data-project-sidebar-target=${JSON.stringify(targetBeta)}]')?.disabled`,
    ),
    true,
  );
  if (
    !pageValue(
      "document.querySelector('details[data-project-sidebar-legacy-compat]')?.open === true",
    )
  ) {
    click("details[data-project-sidebar-legacy-compat] > summary");
  }
  assertStep(
    pageValue(
      "document.body.innerText.includes('Non-Git legacy task history') && document.body.innerText.includes('Old Host legacy task history')",
    ),
    "a nonempty modern tree keeps non-Git and old-Host history reachable through its compatibility section",
  );
  await pageValue(
    `window.__projectSidebarMultiTarget.setHostUnsupported(${JSON.stringify(targetBeta)}, false).then(() => true)`,
  );
  click("button[aria-label='Refresh project workspaces']");
  await waitFor(
    "Beta target recovered after compatibility scenario",
    `document.querySelector(${JSON.stringify(betaRow)})?.innerText.includes('live')`,
  );

  await pageValue(
    `window.__projectSidebarMultiTarget.setOffline(${JSON.stringify(targetAlpha)}, true).then(() => true)`,
  );
  click("button[aria-label='Refresh project workspaces']");
  await waitFor(
    "Alpha offline and Beta live",
    `document.querySelector(${JSON.stringify(alphaRow)})?.innerText.includes('offline') && document.querySelector(${JSON.stringify(betaRow)})?.innerText.includes('live')`,
  );
  assertStep(
    !pageValue(
      `[...document.querySelectorAll('[data-project-sidebar-session="same-session"]')].some((row) => row.getAttribute('aria-label')?.includes('Last turn completed'))`,
    ),
    "losing Alpha connectivity preserves its running summary instead of fabricating completion",
  );
  state = await driverState();
  const alphaReference = state.catalog.projects
    .find((item) => item.id === project.id)
    .workspaceReferences.find((item) => item.targetId === targetAlpha);
  const betaReference = state.catalog.projects
    .find((item) => item.id === project.id)
    .workspaceReferences.find((item) => item.targetId === targetBeta);
  assert.equal(alphaReference.targetFreshness, "offline");
  assert.equal(betaReference.targetFreshness, "live");
  assert.ok(alphaReference.presentation.sessionSummary.sessions.length > 0);
  screenshot("offline", screenshotPaths.offline);

  browser("eval", "location.reload(); true");
  await waitFor(
    "profile tree after browser reload",
    `document.querySelector('[data-project-sidebar-project=${JSON.stringify(project.id)}]') && document.querySelectorAll('[data-project-sidebar-workspace=${JSON.stringify(sharedWorkspaceId)}]').length === 2`,
  );
  assertStep(
    pageValue(
      `document.querySelector(${JSON.stringify(alphaRow)})?.innerText.includes('offline') && document.querySelector(${JSON.stringify(betaRow)})?.innerText.includes('live')`,
    ),
    "profile Catalog and cached summaries restore both target rows after reload",
  );

  const betaHoldOld = await pageValue(
    `window.__projectSidebarMultiTarget.holdRead(${JSON.stringify(targetBeta)})`,
  );
  click("button[aria-label='Refresh project workspaces']");
  await waitForDriver("old-generation Worktree read", (value) =>
    value.heldReads.some((hold) => hold.holdId === betaHoldOld && hold.started),
  );
  await driverControl("/__project-sidebar/control/rename", {
    targetId: targetBeta,
    workspaceId: sharedWorkspaceId,
    title: "Late old-generation title",
  });
  const betaHoldCurrent = await pageValue(
    `window.__projectSidebarMultiTarget.holdRead(${JSON.stringify(targetBeta)})`,
  );
  await driverControl("/__project-sidebar/control/rename", {
    targetId: targetBeta,
    workspaceId: sharedWorkspaceId,
    title: "Current target generation title",
  });
  await pageValue(
    `window.__projectSidebarMultiTarget.reconnect(${JSON.stringify(targetBeta)}); true`,
  );
  await pageValue(
    `window.__projectSidebarMultiTarget.releaseRead(${JSON.stringify(betaHoldOld)}).then(() => true)`,
  );
  await waitForDriver("current-generation Worktree read", (value) =>
    value.heldReads.some((hold) => hold.holdId === betaHoldCurrent && hold.started),
  );
  state = await driverState();
  const heldBetaReference = state.catalog.projects
    .find((item) => item.id === project.id)
    .workspaceReferences.find((item) => item.targetId === targetBeta);
  assert.notEqual(heldBetaReference.presentation.worktree.title, "Late old-generation title");
  await pageValue(
    `window.__projectSidebarMultiTarget.releaseRead(${JSON.stringify(betaHoldCurrent)}).then(() => true)`,
  );
  await waitForText("Current target generation title");
  state = await driverState();
  const currentBetaReference = state.catalog.projects
    .find((item) => item.id === project.id)
    .workspaceReferences.find((item) => item.targetId === targetBeta);
  assert.equal(currentBetaReference.presentation.worktree.title, "Current target generation title");
  assertStep(
    true,
    "late reads from a previous attachment generation cannot replace the new target snapshot",
  );

  await pageValue(
    `window.__projectSidebarMultiTarget.replaceTarget(${JSON.stringify(targetBeta)}, ${JSON.stringify(targetDelta)}); true`,
  );
  click("button[aria-label='Refresh project workspaces']");
  await waitFor(
    "mismatched reconnect retains old target reference",
    `document.querySelector(${JSON.stringify(betaRow)})?.innerText.includes('offline')`,
  );
  state = await driverState();
  const projectAfterDifferentTarget = state.catalog.projects.find((item) => item.id === project.id);
  assert.ok(
    projectAfterDifferentTarget.workspaceReferences.some(
      (reference) => reference.targetId === targetBeta,
    ),
  );
  assert.ok(
    !projectAfterDifferentTarget.workspaceReferences.some(
      (reference) => reference.targetId === targetDelta,
    ),
  );
  assert.equal(projectAfterDifferentTarget.defaultWorkspaceTargetId, targetAlpha);
  assertStep(
    true,
    "a different target ID leaves old cached ownership offline and does not migrate its references",
  );
  if (!pageValue("window.__projectSidebarMultiTarget.reconnectFlowOpened()")) {
    click("button[data-project-sidebar-reconnect-target='true']");
  }
  assert.equal(pageValue("window.__projectSidebarMultiTarget.reconnectFlowOpened()"), true);
  assertStep(
    true,
    "offline rows expose the app's existing remote connection flow without guessing a host",
  );

  await pageValue(
    `window.__projectSidebarMultiTarget.setOffline(${JSON.stringify(targetAlpha)}, false).then(() => true)`,
  );
  await importProject({
    targetId: targetGamma,
    existingProjectId: project.id,
    path: health.repoPath,
    deferSelection: true,
  });
  await waitFor(
    "Gamma candidate",
    `document.querySelector('[data-project-sidebar-candidate=${JSON.stringify(health.repoPath)}]')`,
  );
  state = await driverState();
  const gammaWorktreeCountBeforeFailure = state.worktrees[targetGamma].workspaces.length;
  const gammaBindingCountBeforeFailure = state.worktrees[targetGamma].bindings.length;
  await pageValue("window.__projectSidebarMultiTarget.failNextCatalogWrite().then(() => true)");
  click(`button[data-project-sidebar-candidate=${JSON.stringify(health.repoPath)}]`);
  await waitForText("fixture-catalog-reference-write-failed");
  state = await driverState();
  assert.equal(state.worktrees[targetGamma].workspaces.length, gammaWorktreeCountBeforeFailure + 1);
  assert.equal(state.worktrees[targetGamma].bindings.length, gammaBindingCountBeforeFailure + 1);
  assert.ok(
    !state.catalog.projects
      .find((item) => item.id === project.id)
      .workspaceReferences.some((reference) => reference.targetId === targetGamma),
  );
  const gammaWorkspaceIdsBeforeRetry = state.worktrees[targetGamma].workspaces.map(
    (workspace) => workspace.id,
  );
  await waitFor(
    "Gamma candidate retry enabled after the partial Catalog failure",
    `(() => { const button = document.querySelector('[data-project-sidebar-candidate=${JSON.stringify(health.repoPath)}]'); return Boolean(button && !button.disabled); })()`,
  );
  scrollIntoView(`button[data-project-sidebar-candidate=${JSON.stringify(health.repoPath)}]`);
  await sleep(100);
  pageValue(
    `(() => { window.__gammaRetryBusyTransitions = []; const form = document.querySelector('[data-project-sidebar-add-form]'); if (!form) return false; new MutationObserver(() => window.__gammaRetryBusyTransitions.push(form.getAttribute('aria-busy'))).observe(form, { attributes: true, attributeFilter: ['aria-busy'] }); return true; })()`,
  );
  click(`button[data-project-sidebar-candidate=${JSON.stringify(health.repoPath)}]`);
  try {
    await waitForDriver(
      "Gamma reference retry",
      (value) =>
        value.catalog.projects
          .find((item) => item.id === project.id)
          ?.workspaceReferences.some((reference) => reference.targetId === targetGamma),
      10_000,
    );
  } catch (error) {
    const failedRetryState = await driverState();
    record(
      `Gamma retry diagnostics: ${JSON.stringify({
        projectReferences: failedRetryState.catalog.projects
          .find((item) => item.id === project.id)
          ?.workspaceReferences.map((reference) => reference.targetId),
        gammaWorkspaces: failedRetryState.worktrees[targetGamma].workspaces.map(
          (workspace) => workspace.id,
        ),
        counters: failedRetryState.counters,
        addFormAlert: pageValue(
          "document.querySelector('[data-project-sidebar-add-form] [role=alert]')?.innerText ?? null",
        ),
        retryBusyTransitions: pageValue("window.__gammaRetryBusyTransitions ?? []"),
        candidateDisabled: pageValue(
          `document.querySelector('[data-project-sidebar-candidate=${JSON.stringify(health.repoPath)}]')?.disabled ?? null`,
        ),
        candidatePressed: pageValue(
          `document.querySelector('[data-project-sidebar-candidate=${JSON.stringify(health.repoPath)}]')?.getAttribute('aria-pressed') ?? null`,
        ),
      })}`,
    );
    throw error;
  }
  state = await driverState();
  assert.equal(state.worktrees[targetGamma].workspaces.length, gammaWorktreeCountBeforeFailure + 1);
  assert.deepEqual(
    state.worktrees[targetGamma].workspaces.map((workspace) => workspace.id),
    gammaWorkspaceIdsBeforeRetry,
  );
  assert.ok(
    state.catalog.projects
      .find((item) => item.id === project.id)
      .workspaceReferences.some((reference) => reference.targetId === targetGamma),
  );
  assert.equal(
    state.catalog.projects.find((item) => item.id === project.id).defaultWorkspaceTargetId,
    targetAlpha,
  );
  assertStep(
    true,
    "partial target adoption retries only the missing scoped Catalog reference and preserves other targets/default",
  );

  const workspaceAddButton = `button[aria-label=${JSON.stringify(`Add a workspace to ${projectName}`)}]`;
  click(workspaceAddButton);
  await waitFor(
    "explicit repository selector",
    `document.querySelector('select[aria-label="Repository target"]')`,
  );
  await waitFor(
    "all workspace target bindings are read",
    `document.querySelectorAll('select[aria-label="Repository target"] option').length >= 3`,
  );
  const bindingSelectorState = pageValue(
    `JSON.stringify({ value: document.querySelector('select[aria-label="Repository target"]')?.value, count: document.querySelectorAll('select[aria-label="Repository target"] option').length, submitDisabled: document.querySelector('[data-project-sidebar-workspace-form] button[type="submit"]')?.disabled })`,
  );
  assert.equal(bindingSelectorState.value, "");
  assert.ok(bindingSelectorState.count >= 3);
  assert.equal(bindingSelectorState.submitDisabled, true);
  assertStep(
    true,
    "a Project with multiple target bindings requires explicit workspace-create binding selection",
  );
  const firstWorkspaceBinding = pageValue(
    `document.querySelector('select[aria-label="Repository target"]')?.options[1]?.value ?? ""`,
  );
  assert.ok(firstWorkspaceBinding);
  selectValue('select[aria-label="Repository target"]', firstWorkspaceBinding);
  click(
    `form[data-project-sidebar-workspace-form=${JSON.stringify(project.id)}] button:last-child`,
  );

  await importProject({
    targetId: targetGamma,
    name: "Bare repository project",
    path: health.barePath,
    deferBareAdoption: true,
  });
  await waitForText("This bare repository has no worktrees");
  assert.equal(
    pageValue("document.querySelectorAll('[data-project-sidebar-candidate]').length"),
    0,
  );
  click("button[data-project-sidebar-add-bare='true']");
  await waitForDriver("bare Project repository binding", (value) =>
    value.catalog.projects.some(
      (item) =>
        item.name === "Bare repository project" &&
        item.workspaceReferences.length === 0 &&
        item.repositoryReferences.length === 1,
    ),
  );
  state = await driverState();
  const bareProject = state.catalog.projects.find(
    (item) => item.name === "Bare repository project",
  );
  assert.ok(bareProject);
  assert.equal(bareProject.workspaceReferences.length, 0);
  assert.equal(bareProject.defaultWorkspaceId, undefined);
  assert.equal(bareProject.repositoryReferences.length, 1);
  assert.equal(
    state.worktrees[targetGamma].workspaces.some(
      (workspace) => workspace.projectId === bareProject.id,
    ),
    false,
  );
  screenshot("bare", screenshotPaths.bare);

  const bareWorkspaceFormButton = `button[aria-label=${JSON.stringify(`Add a workspace to Bare repository project`)}]`;
  click(bareWorkspaceFormButton);
  await waitFor(
    "adopted bare binding in workspace form",
    `document.querySelector('select[aria-label="Repository target"]')?.value.includes(${JSON.stringify(`${targetGamma}\0`)})`,
  );
  const barePathOut = join(health.root, "linked bare worktree");
  fill("input[aria-label='Workspace title']", "Bare linked workspace");
  fill("input[aria-label='New worktree path']", barePathOut);
  fill("input[aria-label='Base ref']", "main");
  fill("input[aria-label='New branch']", "feature/bare-sidebar");
  click(
    `form[data-project-sidebar-workspace-form=${JSON.stringify(bareProject.id)}] button[type='submit']`,
  );
  await waitForDriver(
    "linked bare workspace persisted",
    (value) =>
      value.catalog.projects
        .find((item) => item.id === bareProject.id)
        ?.workspaceReferences.some((reference) => reference.targetId === targetGamma) &&
      value.worktrees[targetGamma].workspaces.some(
        (workspace) => workspace.worktreePath === barePathOut,
      ),
  );
  const bareProjectToggle = `button[data-project-sidebar-project-toggle=${JSON.stringify(bareProject.id)}]`;
  if (
    pageValue(
      `document.querySelector(${JSON.stringify(bareProjectToggle)})?.getAttribute('aria-expanded') !== 'true'`,
    )
  ) {
    click(bareProjectToggle);
  }
  await waitFor(
    "real linked worktree creation from bare binding",
    `document.body.innerText.includes(${JSON.stringify("Bare linked workspace")})`,
  );
  assert.ok(existsSync(barePathOut));
  const bareWorktreeList = execFileSync(
    "git",
    ["-C", health.barePath, "worktree", "list", "--porcelain", "-z"],
    {
      encoding: "utf8",
      env: { ...process.env, PATH: pathEnvironment },
    },
  );
  assert.ok(bareWorktreeList.includes(barePathOut));
  state = await driverState();
  const bareProjectAfterCreate = state.catalog.projects.find((item) => item.id === bareProject.id);
  assert.equal(bareProjectAfterCreate.workspaceReferences.length, 1);
  assert.equal(bareProjectAfterCreate.defaultWorkspaceTargetId, targetGamma);
  assertStep(
    true,
    "bare import persists only a binding; selected branch/base/path creates a real linked Git worktree later",
  );

  await importProject({
    targetId: targetGamma,
    name: "Empty bare project",
    path: health.emptyBarePath,
    deferBareAdoption: true,
  });
  await waitForText("This bare repository has no worktrees");
  click("button[data-project-sidebar-add-bare='true']");
  await waitForDriver("empty bare Project binding", (value) =>
    value.catalog.projects.some(
      (item) =>
        item.name === "Empty bare project" &&
        item.workspaceReferences.length === 0 &&
        item.repositoryReferences.length === 1,
    ),
  );
  state = await driverState();
  const emptyBareProject = state.catalog.projects.find(
    (item) => item.name === "Empty bare project",
  );
  assert.ok(emptyBareProject);
  assert.equal(emptyBareProject.workspaceReferences.length, 0);
  const emptyBareWorkspaceButton = `button[aria-label=${JSON.stringify(`Add a workspace to Empty bare project`)}]`;
  scrollIntoView(emptyBareWorkspaceButton);
  click(emptyBareWorkspaceButton);
  await waitFor(
    "empty bare binding in workspace form",
    `document.querySelector('select[aria-label="Repository target"]')?.value.includes(${JSON.stringify(`${targetGamma}\0`)})`,
  );
  const emptyBareOut = join(health.root, "empty bare linked output");
  fill("input[aria-label='Workspace title']", "Must remain uncreated");
  fill("input[aria-label='New worktree path']", emptyBareOut);
  fill("input[aria-label='Base ref']", "main");
  fill("input[aria-label='New branch']", "feature/empty-bare");
  const emptyBareSubmit = `form[data-project-sidebar-workspace-form=${JSON.stringify(emptyBareProject.id)}] button[type='submit']`;
  scrollIntoView(emptyBareSubmit);
  click(emptyBareSubmit);
  await waitForText("This repository has no commit at the selected base ref");
  assert.equal(existsSync(emptyBareOut), false);
  state = await driverState();
  assert.equal(
    state.worktrees[targetGamma].workspaces.some(
      (workspace) => workspace.projectId === emptyBareProject.id,
    ),
    false,
  );
  assert.equal(
    state.catalog.projects.find((item) => item.id === emptyBareProject.id).workspaceReferences
      .length,
    0,
  );
  assertStep(
    true,
    "empty bare stays a binding-only Project after the real Git base-ref validation rejects creation",
  );

  const catalogFilePath = join(health.root, "profile-project-catalog.json");
  const alphaFilePath = join(health.root, "target-alpha-worktrees.json");
  const betaFilePath = join(health.root, "target-beta-worktrees.json");
  assert.ok(existsSync(catalogFilePath));
  assert.ok(existsSync(alphaFilePath));
  assert.ok(existsSync(betaFilePath));
  const persistedCatalogJson = readFileSync(catalogFilePath, "utf8");
  assert.equal(persistedCatalogJson.includes("sidebar-attachment-"), false);
  record(`real owner files verified: ${catalogFilePath}, ${alphaFilePath}, ${betaFilePath}`);

  browser("set", "viewport", "375", "812");
  screenshot("mobile", screenshotPaths.mobile);
  assertStep(
    pageValue(
      "document.documentElement.clientWidth === 375 && document.querySelector('select[aria-label=\"Target\"]') !== null",
    ),
    "target and repository selection remain available at mobile width",
  );

  report = {
    status: "passed",
    node: process.version,
    gitVersion: health.gitVersion,
    root: health.root,
    targets: [targetAlpha, targetBeta, targetGamma, targetDelta],
    repoPath: health.repoPath,
    barePath: health.barePath,
    emptyBarePath: health.emptyBarePath,
    persistedFiles: [catalogFilePath, alphaFilePath, betaFilePath],
    screenshots: screenshotFiles,
    steps,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
} catch (error) {
  report = {
    status: "failed",
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    screenshots: screenshotFiles,
    steps,
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  throw error;
} finally {
  await stopProcessGroup(chromeProcess);
  await stopProcessGroup(vite);
  await stopProcessGroup(driver);
}

record(`report written to ${reportPath}`);
process.stdout.write(`${JSON.stringify({ reportPath, screenshots: screenshotFiles }, null, 2)}\n`);
