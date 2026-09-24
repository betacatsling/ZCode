/* Test-only composition of the production Electron window lifecycle, utility Host and Core mount. */
import { app, session, type UtilityProcess } from "electron";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";

// The parent fixture owns the disposable profile before any production module is imported.
if (
  process.env.ZCODE_ACTUAL_SHELL_FIXTURE !== "1" ||
  !process.env.ZCODE_ACTUAL_CORE_LOCATION ||
  !process.env.ZCODE_DESKTOP_USER_DATA_DIR ||
  !process.env.ZCODE_ACTUAL_WORKSPACE_PATH ||
  !process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE
) {
  throw new Error("Owned isolated actual-Shell fixture required");
}
await mkdir(process.env.ZCODE_DESKTOP_USER_DATA_DIR, { recursive: true });
app.setPath("userData", process.env.ZCODE_DESKTOP_USER_DATA_DIR);

void (async () => {
  // Main production imports register privileged Electron schemes before app ready.
  const [lifecycle, host, core, broadcast, services] = await Promise.all([
    import("../src/main/desktopWindowLifecycle.js"),
    import("../src/main/desktopHostProcess.js"),
    import("../src/host/targetCoreMount.js"),
    import("../src/main/broadcastHub.js"),
    import("@zcode/services"),
  ]);
  await app.whenReady();
  // Test profile has no credential-bearing/external HTTP destination. Node's Core ticket on
  // loopback is privileged; the renderer never receives the one-use capability header.
  session.defaultSession.webRequest.onBeforeRequest((request, callback) => {
    const url = new URL(request.url);
    callback({
      cancel: !(
        ["file:", "data:", "devtools:"].includes(url.protocol) ||
        (url.hostname === "127.0.0.1" && ["http:", "https:", "ws:"].includes(url.protocol))
      ),
    });
  });
  const location: import("../src/host/targetCoreMount.js").CoreAttachmentLocation = JSON.parse(
    process.env.ZCODE_ACTUAL_CORE_LOCATION!,
  );
  const workspace = process.env.ZCODE_ACTUAL_WORKSPACE_PATH!;
  // Actual Core Catalog creates these facts through public ticketed RPC; no renderer snapshot
  // or substitute Host/Catalog service object participates in UI assertions.
  const imported = await core.mountLocalCore(location);
  try {
    const catalog = imported.services.get(services.IProjectCatalogRpcService);
    await catalog.importProject({
      id: "project",
      bindingId: "binding",
      targetId: location.installationId,
      name: "Fixture Git",
      repositoryPath: workspace,
    });
    await catalog.adopt({
      bindingId: "binding",
      workspaceId: "main",
      title: "Main checkout",
      worktreePath: workspace,
    });
  } finally {
    imported.attachment.dispose();
  }
  // Test-only read observer creates a separate one-use ticket and reads the SAME Core owner;
  // it cannot write fabricated service facts to the renderer or execute a second Host.
  (
    globalThis as typeof globalThis & {
      __actualShellRead?: (id: string) => Promise<unknown>;
    }
  ).__actualShellRead = async (id) => {
    const read = await core.mountLocalCore(location);
    try {
      const service = read.services.get(services.IAgentHostService);
      const spec = await service.getSessionSpec({
        targetId: location.installationId,
        workspaceId: "main",
        hostSessionId: id,
      });
      if (!spec) throw new Error("Original Core Host session not found");
      return {
        spec,
        snapshot: await service.snapshot(spec),
        events: await service.eventsSince(spec, 0),
      };
    } finally {
      read.attachment.dispose();
    }
  };
  const logger = {
    info: (...messages: unknown[]) =>
      process.stderr.write(`[actual-shell] ${messages.map(String).join(" ")}\n`),
    warn: (...messages: unknown[]) =>
      process.stderr.write(`[actual-shell:warn] ${messages.map(String).join(" ")}\n`),
  };
  const children = new Map<number, UtilityProcess>();
  const timers = new WeakMap<UtilityProcess, ReturnType<typeof setTimeout>>();
  const hub = new broadcast.BroadcastHub();
  const forceQuitRef = { current: true };
  const window = lifecycle.createWindow({
    iconPath: "",
    preloadPath: join(import.meta.dirname, "../preload/index.cjs"),
    logger,
    forceQuitRef,
    windowHostProcessMap: children,
    prepareLocalCore: async () => location,
    spawnHostProcess: (win, label, initMessage, localCoreEndpoint) =>
      host.spawnHostProcess(
        win,
        label,
        {
          ...initMessage,
          zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
        },
        {
          hostProcessLocalEnv: {},
          localCoreEndpoint,
          logger,
          broadcastHub: hub,
          windowHostProcessMap: children,
          hostRunningTaskCountMap: new Map(),
        },
      ),
    disposeHostProcess: (child, label, forceKillDelayMs) =>
      host.disposeHostProcess(child, label, timers, logger, forceKillDelayMs),
    syncAutoUpdaterStateToWindow: () => {},
    syncReadyUpdateToWindow: () => {},
    syncPostUpdateReleaseNotesToWindow: () => {},
    disposeRemoteWorkspaceSessionsForWindow: () => {},
    reattachRemoteWorkspaceSessionsForWindow: () => {},
    bootstrap: { restoreSession: false, supportsSettings: false, initialWorkspacePath: workspace },
    agentSpawnFallbackCwd: workspace,
    deviceMid: "actual-shell-owned",
    runtimeProcessEnvFallbackPatch: {},
  });
  window.hide();
  // Whole-app onboarding needs unrelated account information. Keep the production window,
  // preload, Host port and real client connector, but mount the product Shell directly.
  window.webContents.once("did-finish-load", () => {
    void window.loadFile(join(import.meta.dirname, "../renderer/actual-shell-mount.html"));
  });
  let closing = false;
  app.on("before-quit", (event) => {
    if (closing) return;
    closing = true;
    event.preventDefault();
    void Promise.all(
      [...children.values()].map((child) =>
        host.disposeHostProcessAndWait(child, "actual-shell-exit", timers, logger, {
          waitTimeoutMs: 8_000,
        }),
      ),
    ).finally(() => app.exit(0));
  });
})().catch((error: unknown) => {
  process.stderr.write(
    `[actual-shell:failed] ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  app.exit(1);
});
