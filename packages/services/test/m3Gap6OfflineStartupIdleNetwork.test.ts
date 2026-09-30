/**
 * M3 gap 6 (REMOVE-PRODUCT-LOGIN-PLAN §7 rows 1 and 11): offline start → workspace/history, and
 * start + idle network observation.
 *
 * The real Node service assembly (`createLocalServices`, the same call the standalone HTTP server
 * entry makes) runs in-process under an offline network guard, with a temp data/home directory
 * that contains leftover product-login credentials and account settings. Nothing here is mocked
 * inside services; the guard only replaces the network.
 *
 * Observed current behaviour (documented, not hidden): the service layer makes exactly one kind
 * of non-loopback request at startup and while idle, the anonymous ZCode Built-in provider
 * config check `GET https://zcode.z.ai/api/v1/client/configs?app_version&platform`
 * (provider-node `downloadZCodeBuiltinRelease`, `credentials: "omit"`, no Authorization/Cookie).
 * Offline it fails and backs off exponentially (60 s base, 1 h cap) on a 60 s check interval.
 * It is not an auth/renewal/account/plan request, but it is product-host traffic; the tests pin
 * it exactly so any new product request (or a change in this one) fails loudly.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import dns from "node:dns";
import { once } from "node:events";
import { mkdirSync, mkdtempSync } from "node:fs";
import { readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  installOfflineNetworkGuard,
  isProductLoginAttempt,
  type OutboundAttempt,
} from "./fixtures/offlineNetworkGuard.js";

// ---------------------------------------------------------------------------
// Process-wide setup. Paths are resolved from env at module load inside services, so the temp
// home and the guard must exist before the first services import below.
// ---------------------------------------------------------------------------
const preGuardFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const root = mkdtempSync(join(tmpdir(), "zcode-m3-gap6-"));
const home = join(root, "home");
mkdirSync(home, { recursive: true });
process.env.HOME = home;
process.env.ZCODE_DATA_BASE_DIR = home;
process.env.ZCODE_DESKTOP_HOME_DIR = home;
// Production default endpoint (no test override), no proxy: observe what a user install would do.
for (const key of [
  "ZCODE_ENV",
  "ZCODE_BASE_URL",
  "ZCODE_ENDPOINT_ORIGIN",
  "ZCODE_OFFPEAK_MOCK",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
]) {
  delete process.env[key];
}
const guard = installOfflineNetworkGuard();
// Service loggers resolve `console.warn` per call; keep a copy to prove background loops really ran.
const warnings: string[] = [];
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
  warnings.push(
    args
      .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
      .join(" "),
  );
  originalWarn(...args);
};
const offPeakSyncFailures = () =>
  warnings.filter((line) => line.includes("off-peak sync cycle failed"));

const { createLocalServices, disposeServiceResourcesAndWait, getAppConfigDir } =
  await import("../src/node.js");
const {
  IAgentHostService,
  IModelSelectionService,
  IProjectCatalogService,
  IWorktreeService,
  IZCodeTaskService,
} = await import("../src/index.js");
const { AgentHostTargetService } = await import("../src/agent-host/targetService.js");
const { HarnessRegistry } = await import("../src/agent-host/harnessRegistry.js");
const { MockHarness } = await import("../src/agent-host/mockHarness.js");
const { TaskIndexRepo } = await import("../src/session/taskIndexRepo.js");
const { OffPeakTaskRepo } = await import("../src/session/offPeakTaskRepo.js");

const builtinFilePath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);
const TARGET_ID = "m3-gap6-offline-target";
const PRODUCT_ORIGIN = "https://zcode.z.ai";
const CLIENT_CONFIG_PATH = "/api/v1/client/configs";
const LEGACY_JWT = "legacy-product-jwt-must-never-be-sent";
const LEGACY_CREDENTIALS = {
  "oauth:active_provider": 1,
  "oauth:zai:access_token": LEGACY_JWT,
  "oauth:zai:refresh_token": "legacy-refresh-token-must-never-be-sent",
  "oauth:zai:user_info": { id: "legacy-user" },
  "oauth:bigmodel:access_token": LEGACY_JWT,
  "oauth:bigmodel:refresh_token": "legacy-refresh-token-must-never-be-sent",
  zcodejwttoken: LEGACY_JWT,
  "oauth:login_attribution": '{"channel_id":"legacy"}',
  "account-provider:zai:api-key": "legacy-derived-plan-key",
  "personal:example:api-key": "keep-me",
};
const LEGACY_SETTINGS = {
  providerFamilyDomain: "zai",
  providerFamilyDomainMigrated: true,
  providerFamilyDomainUpdatedAt: 1_700_000_000_000,
};
const HISTORY_TEXT = "retained offline history after product logout";

after(async () => {
  console.warn = originalWarn;
  guard.uninstall();
  await rm(root, { recursive: true, force: true });
});

function startServices() {
  // Same options as packages/server/src/entry-http.ts (standalone server without auth token).
  return createLocalServices({
    zcodeBuiltinProviderConfigFilePath: builtinFilePath,
    serviceAuthorityMode: "standalone-server",
    agentHostTargetId: TARGET_ID,
  });
}

async function realSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => realSetTimeout(resolve, ms));
}

/** Wait (real time) until no new outbound attempt appears for `quietMs`. */
async function settle(quietMs = 150, maxMs = 5_000): Promise<void> {
  const started = performance.now();
  let count = guard.attempts.length;
  let quietSince = performance.now();
  while (performance.now() - started < maxMs) {
    await realSleep(25);
    if (guard.attempts.length !== count) {
      count = guard.attempts.length;
      quietSince = performance.now();
    } else if (performance.now() - quietSince >= quietMs) {
      return;
    }
  }
}

function isBuiltinConfigCheck(attempt: OutboundAttempt): boolean {
  if (attempt.layer !== "fetch" || attempt.method !== "GET") return false;
  const url = new URL(attempt.target);
  return (
    url.origin === PRODUCT_ORIGIN &&
    url.pathname === CLIENT_CONFIG_PATH &&
    [...url.searchParams.keys()].sort().join(",") === "app_version,platform"
  );
}

function assertOnlyAnonymousBuiltinConfigChecks(attempts: readonly OutboundAttempt[]): void {
  assert.deepEqual(
    attempts.filter(isProductLoginAttempt),
    [],
    "no product auth/renewal/account/plan request",
  );
  for (const attempt of attempts) {
    assert.ok(isBuiltinConfigCheck(attempt), `unexpected outbound: ${JSON.stringify(attempt)}`);
    const headerNames = Object.keys(attempt.headers ?? {});
    assert.equal(headerNames.includes("authorization"), false);
    assert.equal(headerNames.includes("cookie"), false);
    assert.equal(JSON.stringify(attempt).includes(LEGACY_JWT), false);
    assert.equal(JSON.stringify(attempt).includes("legacy-refresh-token"), false);
    assert.equal(JSON.stringify(attempt).includes("legacy-derived-plan-key"), false);
  }
}

const git = promisify(execFile);
async function createRepository(): Promise<string> {
  const repositoryPath = join(root, "offline workspace");
  await git("git", ["init", "-q", repositoryPath]);
  await git("git", ["-C", repositoryPath, "config", "user.email", "gap6@example.com"]);
  await git("git", ["-C", repositoryPath, "config", "user.name", "Gap6"]);
  await writeFile(join(repositoryPath, "README.md"), "offline\n", "utf8");
  await git("git", ["-C", repositoryPath, "add", "README.md"]);
  await git("git", ["-C", repositoryPath, "commit", "-qm", "initial"]);
  await git("git", ["-C", repositoryPath, "branch", "-M", "main"]);
  return repositoryPath;
}

async function findFiles(dir: string, name: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name === name)
    .map((entry) => join(entry.parentPath, entry.name));
}

// ---------------------------------------------------------------------------
// Positive control: the guard really sees and rejects each layer, so zero counts mean something.
// ---------------------------------------------------------------------------
test("positive control: the offline guard records and rejects product-login traffic on every layer", async () => {
  const mark = guard.mark();
  await assert.rejects(
    fetch("https://chat.z.ai/api/oauth/token", {
      method: "POST",
      headers: { authorization: `Bearer ${LEGACY_JWT}` },
    }),
    TypeError,
  );
  // A fetch reference captured before the guard bypasses the wrapper; the socket layer still sees it.
  await assert.rejects(preGuardFetch("https://open.bigmodel.cn/api/biz/subscription/list"));
  await new Promise<void>((resolve) => {
    const request = https.request("https://api.z.ai/api/v1/user/info", { method: "GET" });
    request.on("error", () => resolve());
    request.end();
  });
  await new Promise<void>((resolve) => {
    net.connect({ host: "203.0.113.7", port: 443 }).on("error", () => resolve());
  });
  await assert.rejects(dns.promises.lookup("zcode.z.ai"), { code: "ENOTFOUND" });

  const seen = guard.since(mark);
  const summary = seen.map(({ layer, host }) => `${layer}:${host}`);
  assert.ok(summary.includes("fetch:chat.z.ai"), summary.join(" "));
  assert.ok(
    summary.includes("socket:open.bigmodel.cn") || summary.includes("dns:open.bigmodel.cn"),
    summary.join(" "),
  );
  assert.ok(summary.includes("http:api.z.ai"), summary.join(" "));
  assert.ok(summary.includes("socket:api.z.ai"), summary.join(" "));
  assert.ok(summary.includes("socket:203.0.113.7"), summary.join(" "));
  assert.ok(summary.includes("dns:zcode.z.ai"), summary.join(" "));
  const tokenCall = seen.find((attempt) => attempt.host === "chat.z.ai");
  assert.ok(tokenCall && isProductLoginAttempt(tokenCall));
  assert.equal(tokenCall.headers?.authorization, `Bearer ${LEGACY_JWT}`);
  assert.ok(seen.filter(isProductLoginAttempt).length >= 3);

  // Loopback stays usable (local fakes, the server under test) and is not counted as outbound.
  const server = createServer((_request, response) => response.end("ok"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as { port: number };
  const before = guard.attempts.length;
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), "ok");
  assert.equal(guard.attempts.length, before);
  assert.ok(guard.loopback.some((entry) => entry.includes(`127.0.0.1:${port}`)));
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// §7 row 1: fresh install offline, then restart offline and open workspace + history.
// ---------------------------------------------------------------------------
test("offline fresh start and restart open the workspace, project and history with legacy login leftovers present", async () => {
  const appConfigDir = getAppConfigDir();
  assert.equal(appConfigDir, join(home, ".zcode", "v2"));
  mkdirSync(appConfigDir, { recursive: true });
  const credentialsPath = join(appConfigDir, "credentials.json");
  const credentialsBytes = `${JSON.stringify(LEGACY_CREDENTIALS, null, 2)}\n`;
  await writeFile(credentialsPath, credentialsBytes, "utf8");
  await writeFile(join(appConfigDir, "setting.json"), JSON.stringify(LEGACY_SETTINGS), "utf8");
  const repositoryPath = await createRepository();

  // Boot 1: fresh install, offline. Create a project and adopt the workspace.
  const bootMark = guard.mark();
  const first = startServices();
  let workspace: {
    id: string;
    worktreePath: string;
    worktreeGeneration: string;
    workspaceIdentity?: string;
  };
  try {
    const catalog = first.get(IProjectCatalogService);
    const worktrees = first.get(IWorktreeService);
    await catalog.createProject({ id: "offline-project", name: "Offline Project" });
    const discovery = await worktrees.discover(repositoryPath);
    assert.equal(discovery.kind, "git");
    if (discovery.kind !== "git") return;
    const adoption = await worktrees.adopt("offline-project", discovery.candidates[0]!);
    workspace = adoption.workspace;
    await catalog.setWorkspaceRefs("offline-project", [workspace.id], workspace.id);
    // Empty model catalog must not block startup and must not invent an executable account model.
    const view = await first.get(IModelSelectionService).getView();
    assert.equal(
      JSON.stringify(view.preferredSelection ?? null).includes("account:"),
      false,
      "no account-derived provider becomes the default",
    );
    await settle();
  } finally {
    await disposeServiceResourcesAndWait(first);
  }

  // Previously persisted history: a finished external session bound to a removed account provider,
  // written by the real Host journal (the production harnesses need a network, the journal does not).
  const workspaceKey = workspace.workspaceIdentity ?? workspace.worktreePath;
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId: "gap6-offline-history",
    execution: {
      targetId: TARGET_ID,
      workspaceIdentity: workspaceKey,
      worktreePath: workspace.worktreePath,
      workspaceId: workspace.id,
      worktreeGeneration: workspace.worktreeGeneration,
    },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed" as const,
      selection: {
        providerId: "account:zai-individual-coding-plan",
        modelId: "glm-4.6",
        options: { reasoningLevel: "off" },
      },
    },
  };
  const registry = new HarnessRegistry();
  // failAfterText finishes the turn without an approval round-trip (same fixture shape as #318).
  registry.register(new MockHarness({ textChunks: [HISTORY_TEXT], failAfterText: true }));
  const writer = new AgentHostTargetService({
    root: join(appConfigDir, "agent-host", "v1", "sessions"),
    target: { id: TARGET_ID, kind: "ssh", platform: process.platform as "linux", available: true },
    catalog: { fingerprint: "seed", validateSelection: () => ({ ok: true as const }) },
    registry,
    authorizeWorktree: async () => true,
  });
  await writer.create(spec);
  await writer.dispatch(spec, {
    type: "send",
    commandId: "gap6-send",
    hostSessionId: spec.hostSessionId,
    turnId: "gap6-turn",
    text: "keep this history readable offline",
  });
  await writer.waitForIdle(spec);
  await writer.dispatch(spec, {
    type: "terminateSession",
    commandId: "gap6-terminate",
    hostSessionId: spec.hostSessionId,
  });
  await writer.close();
  // Native ZCode task index row from the product-login era (legacy account model id).
  const taskIndex = new TaskIndexRepo();
  await taskIndex.seedTaskMetaIfMissing({
    taskId: "gap6-native-task",
    traceId: "gap6-trace",
    title: "Native task from the product-login era",
    workspacePath: workspace.worktreePath,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_001,
    mode: "edit",
    model: "glm-4.6",
    provider: "glm",
  });
  taskIndex.close();
  // A queued off-peak task holding a legacy server ticket: its sync loop must not reach the network.
  const offPeak = new OffPeakTaskRepo();
  await offPeak.create(
    {
      title: "legacy off-peak",
      prompt: "legacy",
      permissionMode: "edit",
      modelSelection: { providerId: "account:zai-individual-coding-plan", modelId: "glm-4.6" },
      workspacePath: workspace.worktreePath,
    },
    { serverTicketId: "legacy-ticket-1", registeredAt: 1_700_000_000_000 },
  );
  assert.equal((await offPeak.listNonTerminal()).length, 1);
  offPeak.close();

  // Boot 2: restart offline and read everything back.
  const syncFailuresBefore = offPeakSyncFailures().length;
  const second = startServices();
  try {
    const project = (await second.get(IProjectCatalogService).read()).projects.find(
      (candidate) => candidate.id === "offline-project",
    );
    assert.ok(project, "project survives an offline restart");
    assert.deepEqual(project.workspaceIds, [workspace.id]);

    const worktrees = second.get(IWorktreeService);
    const reread = (await worktrees.read()).workspaces.find((entry) => entry.id === workspace.id);
    assert.equal(reread?.lifecycle, "active");
    assert.equal(reread?.verification, "verified");
    const revalidated = await worktrees.revalidate(workspace.id);
    assert.equal(revalidated.status, "verified");

    const agentHost = second.get(IAgentHostService);
    const sessions = await agentHost.listSessions(workspaceKey, workspace.worktreePath);
    assert.equal(sessions.length, 1);
    assert.deepEqual(
      sessions[0]?.spec.modelBinding,
      spec.modelBinding,
      "history keeps the original account provider/model identity",
    );
    const snapshot = await agentHost.snapshot(spec);
    assert.ok(snapshot.rows.window.some((row) => JSON.stringify(row).includes(HISTORY_TEXT)));
    const rows = await agentHost.conversationRowsRange({
      spec,
      sessionId: spec.hostSessionId,
      limit: 50,
    });
    assert.ok(rows.rows.some((row) => JSON.stringify(row).includes(HISTORY_TEXT)));

    const tasks = await second.get(IZCodeTaskService).listTasks({
      workspacePath: workspace.worktreePath,
    });
    assert.deepEqual(
      tasks.map(({ taskId, model }) => ({ taskId, model })),
      [{ taskId: "gap6-native-task", model: "glm-4.6" }],
    );
    await settle();
    // The off-peak startup scan really ran for the legacy ticket and failed closed while resolving
    // credentials, before building any request (offPeakServerClient resolves credentials first).
    const syncFailures = offPeakSyncFailures().slice(syncFailuresBefore);
    assert.ok(syncFailures.length >= 1, "off-peak startup sync ran");
    assert.ok(
      syncFailures.every((line) => line.includes("OffPeakCodingPlanUnavailableError")),
      syncFailures.join("\n"),
    );
  } finally {
    await disposeServiceResourcesAndWait(second);
  }

  const observed = guard.since(bootMark);
  assertOnlyAnonymousBuiltinConfigChecks(observed);
  // One anonymous config check at the first boot; the restart is inside the failure back-off.
  assert.equal(observed.length, 1, JSON.stringify(observed));
  // Legacy login material is left on disk untouched (not read into requests, not erased).
  assert.equal(await readFile(credentialsPath, "utf8"), credentialsBytes);
});

// ---------------------------------------------------------------------------
// §7 row 11: idle window. node:test mock timers drive the 60 s check interval, every setTimeout
// (including the off-peak sync back-off) and Date for a virtual 2 hours.
// ---------------------------------------------------------------------------
test("idle for a virtual 2 hours: no product auth/renewal/account request, only the backed-off anonymous config check", async (t) => {
  // Start the idle window from a clean back-off state so the schedule is deterministic.
  for (const control of await findFiles(getAppConfigDir(), "zcode-builtin-refresh.json")) {
    await rm(control);
  }
  const t0 = Date.now();
  mock.timers.enable({ apis: ["setInterval", "setTimeout", "Date"], now: t0 });
  const mark = guard.mark();
  const syncFailuresBefore = offPeakSyncFailures().length;
  const services = startServices();
  try {
    await settle();
    const stepMs = 10_000;
    for (let elapsed = 0; elapsed < 2 * 60 * 60 * 1_000; elapsed += stepMs) {
      mock.timers.tick(stepMs);
      await settle(40);
    }
    const observed = guard.since(mark);
    assertOnlyAnonymousBuiltinConfigChecks(observed);
    const offsetsSeconds = observed.map((attempt) => Math.round((attempt.at - t0) / 1_000));
    t.diagnostic(`anonymous config checks at virtual seconds: ${offsetsSeconds.join(", ")}`);
    // Exact phases depend on when the 60 s interval is armed; the contract is back-off, not polling:
    // one check at startup, then gaps that never shrink, at least 60 s and at most the 1 h cap.
    assert.ok(offsetsSeconds[0]! < 60, "one check at startup");
    const gaps = offsetsSeconds.slice(1).map((offset, index) => offset - offsetsSeconds[index]!);
    for (const [index, gap] of gaps.entries()) {
      assert.ok(gap >= 60, `gap ${gap}s >= 60s`);
      assert.ok(gap <= 3_600 + 120, `gap ${gap}s within the 1 h cap`);
      if (index > 0) assert.ok(gap >= gaps[index - 1]!, `gaps never shrink: ${gaps.join(",")}`);
    }
    assert.ok(observed.length >= 4 && observed.length <= 8, `${observed.length} checks in 2 h`);
    // The off-peak legacy ticket keeps retrying on its own timer and never reaches the network.
    const idleSyncFailures = offPeakSyncFailures().slice(syncFailuresBefore);
    t.diagnostic(`off-peak sync retries while idle: ${idleSyncFailures.length}`);
    assert.ok(idleSyncFailures.length >= 2, "off-peak sync back-off timer fired while idle");
  } finally {
    mock.timers.reset();
    await disposeServiceResourcesAndWait(services);
  }
});
