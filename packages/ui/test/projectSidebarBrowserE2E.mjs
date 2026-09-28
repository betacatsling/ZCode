import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { runProjectSidebarWorkflowScenarios } from "./projectSidebarBrowserWorkflowScenarios.mjs";
import { runProjectSidebarFreshnessScenarios } from "./projectSidebarBrowserFreshnessScenarios.mjs";
import { runProjectSidebarExternalConversationScenarios } from "./projectSidebarExternalConversationScenarios.mjs";
const root = process.cwd();
const outputDirectory =
  process.env.PROJECT_SIDEBAR_E2E_OUTPUT_DIR ?? "/tmp/zcode-gpt6-external-ui/browser";
const agentBrowser = process.env.AGENT_BROWSER_BIN;
const chrome = process.env.CHROME_BIN;
async function allocatePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not allocate a browser test port.");
  const port = address.port;
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}
const vitePort = await allocatePort();
const hostDriverPort = await allocatePort();
const cdpPort = await allocatePort();
if (!agentBrowser || !existsSync(agentBrowser))
  throw new Error("Set AGENT_BROWSER_BIN to the agent-browser CLI.");
if (!chrome || !existsSync(chrome))
  throw new Error("Set CHROME_BIN to a local Chrome/Chromium executable.");
mkdirSync(outputDirectory, { recursive: true });

const logPath = join(outputDirectory, "browser-e2e.log");
const viteLogPath = join(outputDirectory, "vite.log");
const chromeLogPath = join(outputDirectory, "chrome.log");
const hostDriverLogPath = join(outputDirectory, "agent-host-driver.log");
const reportPath = join(outputDirectory, "e2e-report.json");
const screenshots = {
  empty: join(outputDirectory, "empty-catalog-legacy-and-manager.png"),
  hierarchy: join(outputDirectory, "two-project-hierarchy.png"),
  mobile: join(outputDirectory, "mobile-sidebar.png"),
  offline: join(outputDirectory, "same-scope-offline.png"),
  fallback: join(outputDirectory, "old-host-legacy-fallback.png"),
  externalApproval: join(outputDirectory, "first-pi-visible-approval.png"),
  externalConversation: join(outputDirectory, "first-pi-visible-conversation.png"),
  externalHistoryPage: join(outputDirectory, "first-pi-expanded-older-history.png"),
  externalResult: join(outputDirectory, "second-pi-visible-tool-result.png"),
};
const capturedScreenshots = {};
const runId = `${Date.now()}-${process.pid}`;
const chromeProfile = join(outputDirectory, `chrome-profile-${runId}`);
const chromeEnvironment = {
  ...process.env,
  AGENT_BROWSER_SOCKET_DIR: join(outputDirectory, `sockets-${runId}`),
  AGENT_BROWSER_PROFILE: join(outputDirectory, `browser-profile-${runId}`),
  AGENT_BROWSER_EXECUTABLE_PATH: chrome,
  AGENT_BROWSER_DEFAULT_TIMEOUT: process.env.AGENT_BROWSER_DEFAULT_TIMEOUT ?? "60000",
  AGENT_BROWSER_SCREENSHOT_DIR: outputDirectory,
  XDG_CACHE_HOME: join(outputDirectory, "cache"),
};
mkdirSync(chromeEnvironment.XDG_CACHE_HOME, { recursive: true });
mkdirSync(chromeEnvironment.AGENT_BROWSER_SOCKET_DIR, { recursive: true });
mkdirSync(chromeEnvironment.AGENT_BROWSER_PROFILE, { recursive: true });
const viteLog = createWriteStream(viteLogPath, { flags: "a" });
const chromeLog = createWriteStream(chromeLogPath, { flags: "a" });
const hostDriverLog = createWriteStream(hostDriverLogPath, { flags: "a" });
const hostDriver = spawn(
  process.execPath,
  [
    join(root, "node_modules/tsx/dist/cli.mjs"),
    "packages/ui/test/fixtures/agentHostBrowserDriver.ts",
  ],
  {
    cwd: root,
    env: { ...process.env, AGENT_HOST_DRIVER_PORT: String(hostDriverPort) },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
hostDriver.stdout.pipe(hostDriverLog);
hostDriver.stderr.pipe(hostDriverLog);
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
      SIDEBAR_FIXTURE_PORT: String(vitePort),
      AGENT_HOST_DRIVER_PORT: String(hostDriverPort),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
vite.stdout.pipe(viteLog);
vite.stderr.pipe(viteLog);

const chromeProcess = spawn(
  chrome,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${chromeProfile}`,
    `http://127.0.0.1:${vitePort}/projectSidebarBrowser.html`,
  ],
  {
    cwd: root,
    env: {
      ...process.env,
      XDG_CACHE_HOME: join(outputDirectory, "cache"),
      XDG_CONFIG_HOME: join(outputDirectory, "chrome-config"),
      XDG_DATA_HOME: join(outputDirectory, "chrome-data"),
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
chromeProcess.stdout.pipe(chromeLog);
chromeProcess.stderr.pipe(chromeLog);

const steps = [];
function record(message) {
  steps.push({ at: new Date().toISOString(), message });
  appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
}

function browser(...args) {
  const command = ["--cdp", String(cdpPort), ...args];
  const output = execFileSync(agentBrowser, command, {
    encoding: "utf8",
    timeout: Number(process.env.AGENT_BROWSER_COMMAND_TIMEOUT_MS ?? 60_000),
    env: chromeEnvironment,
  });
  appendFileSync(logPath, `$ agent-browser ${command.join(" ")}\n${output}\n`);
  return output.trim();
}

function pageValue(expression) {
  const output = browser("eval", expression);
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    return output;
  }
  if (typeof result === "string") {
    try {
      return JSON.parse(result);
    } catch {
      return result;
    }
  }
  return result;
}

async function waitFor(label, expression, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = pageValue(`Boolean(${expression})`);
    if (value === true) return;
    await sleep(250);
  }
  const body = pageValue("document.body?.innerText ?? ''");
  throw new Error(`Timed out waiting for ${label}; current body: ${String(body).slice(0, 1200)}`);
}

async function waitForBodyText(text, timeoutMs = 30_000) {
  return waitFor(
    `body text ${JSON.stringify(text)}`,
    `document.body?.innerText.includes(${JSON.stringify(text)})`,
    timeoutMs,
  );
}

function click(selector) {
  browser("click", selector);
}

function fill(selector, value) {
  browser("fill", selector, value);
}

function capture(name, path) {
  browser("screenshot", path);
  if (!existsSync(path)) throw new Error(`Screenshot was not created: ${path}`);
  capturedScreenshots[name] = path;
  record(`captured ${name}: ${path}`);
}

function counters() {
  return pageValue("JSON.stringify(window.__projectSidebarFixture.counters())");
}

function fixtureApi(expression) {
  return pageValue(`JSON.stringify(window.__projectSidebarFixture.${expression})`);
}

function assertStep(condition, message) {
  assert.ok(condition, message);
  record(`PASS ${message}`);
}

async function waitForVite() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${vitePort}/projectSidebarBrowser.html`);
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await sleep(250);
  }
  throw new Error("Vite fixture server did not start.");
}

async function waitForHostDriver() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${hostDriverPort}/__agent-host/health`);
      if (response.ok) return response.json();
    } catch {
      // The real service-port fixture is still starting.
    }
    await sleep(250);
  }
  throw new Error("AgentHost service-port driver did not start.");
}

async function waitForCdp() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
      if (response.ok) return;
    } catch {
      // Chrome is still starting.
    }
    await sleep(250);
  }
  throw new Error("Chrome CDP endpoint did not become ready.");
}

async function stopProcessGroup(child) {
  if (!child.pid || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([new Promise((resolve) => child.once("exit", resolve)), sleep(3_000)]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

let exitCode = 0;
try {
  const hostDriverMetadata = await waitForHostDriver();
  await waitForVite();
  await waitForCdp();
  browser("open", `http://127.0.0.1:${vitePort}/projectSidebarBrowser.html`);
  await waitFor(
    "React fixture startup",
    "window.__projectSidebarFixture && document.body.innerText.includes('Legacy workspace and tasks')",
  );
  const scenarioContext = {
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
    record,
    screenshots,
    sleep,
  };
  if (process.env.PROJECT_SIDEBAR_E2E_EXTERNAL_ONLY === "1") {
    await runProjectSidebarExternalConversationScenarios({
      ...scenarioContext,
      hostDriverUrl: `http://127.0.0.1:${hostDriverPort}`,
      hostWorkspacePath: hostDriverMetadata.workspacePath,
    });
  } else {
    await waitForBodyText("No projects are registered.");
    assertStep(
      pageValue(
        "Boolean(document.querySelector('[data-legacy-workspace]') && document.querySelector('[data-project-sidebar-add-project]'))",
      ),
      "empty Catalog keeps old task DOM visible beside a reachable Project creation entry",
    );
    capture("empty Catalog with legacy tasks", screenshots.empty);

    click("button[data-project-sidebar-add-project='true']");
    fill("input[aria-label='Project name']", "Orca UI");
    fill("input[aria-label='Worktree path']", "/fixture/repo/linked");
    click("form[data-project-sidebar-add-form] button[type='submit']");
    await waitFor(
      "explicit worktree candidates",
      "document.querySelectorAll('[data-project-sidebar-candidate]').length === 2",
    );
    await runProjectSidebarWorkflowScenarios(scenarioContext);
    await runProjectSidebarFreshnessScenarios(scenarioContext);
  }
  const report = {
    result: "passed",
    evidenceKind:
      process.env.PROJECT_SIDEBAR_E2E_EXTERNAL_ONLY === "1"
        ? "React/Vite V4 SessionPane + real local AgentHost service-port/bridge; fake Pi Harness, no Provider/SSH/Electron"
        : "isolated React/Vite service-port fixture; no live Provider, SSH or Agent process",
    scope:
      process.env.PROJECT_SIDEBAR_E2E_EXTERNAL_ONLY === "1"
        ? "External-only fixture slice. Pi is a credential-free fake Harness; no live Provider/API, SSH credentials, or Electron process."
        : "Project sidebar fixture workflow; no live Provider, SSH, or Agent process.",
    node: process.version,
    projectRoot: root,
    screenshots: capturedScreenshots,
    browserLog: logPath,
    viteLog: viteLogPath,
    chromeLog: chromeLogPath,
    hostDriverLog: hostDriverLogPath,
    hostWorkspacePath: hostDriverMetadata.workspacePath,
    steps,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  exitCode = 1;
  const failure = {
    result: "failed",
    error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    screenshots: capturedScreenshots,
    browserLog: logPath,
    viteLog: viteLogPath,
    chromeLog: chromeLogPath,
    hostDriverLog: hostDriverLogPath,
    steps,
  };
  writeFileSync(reportPath, `${JSON.stringify(failure, null, 2)}\n`);
  console.error(JSON.stringify(failure, null, 2));
} finally {
  await Promise.all([
    stopProcessGroup(vite),
    stopProcessGroup(chromeProcess),
    stopProcessGroup(hostDriver),
  ]);
  viteLog.end();
  chromeLog.end();
  hostDriverLog.end();
}

process.exitCode = exitCode;
