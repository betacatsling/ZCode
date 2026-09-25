/* Test-only composition of the production Electron window lifecycle, utility Host and Core mount. */
import { app, BrowserWindow, ipcMain, session, type UtilityProcess } from "electron";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { PlatformChannels } from "@zcode/shared";
import { resolveDesktopZoomLevelFromFactor } from "../src/main/desktopZoom.js";

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
  const [lifecycle, host, core, broadcast, services, pairedPhone] = await Promise.all([
    import("../src/main/desktopWindowLifecycle.js"),
    import("../src/main/desktopHostProcess.js"),
    import("../src/host/targetCoreMount.js"),
    import("../src/main/broadcastHub.js"),
    import("@zcode/services"),
    import("../src/main/pairedPhoneDesktop.js"),
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
  (
    globalThis as typeof globalThis & { __actualShellHostPid?: () => number | undefined }
  ).__actualShellHostPid = () => [...children.values()][0]?.pid;
  (
    globalThis as typeof globalThis & { __actualShellCensus?: () => Promise<unknown> }
  ).__actualShellCensus = async () => {
    const read = await core.mountLocalCore(location);
    try {
      return (
        await read.services.get(services.IProjectCatalogRpcService).sidebarSnapshot()
      ).sessions
        .filter((row) => row.session.workspaceId === "main")
        .map((row) => ({ id: row.session.id, harnessId: row.session.harnessId }));
    } finally {
      read.attachment.dispose();
    }
  };
  const timers = new WeakMap<UtilityProcess, ReturnType<typeof setTimeout>>();
  const hub = new broadcast.BroadcastHub();
  const forceQuitRef = { current: true };
  let attachment: ReturnType<typeof pairedPhone.registerPairedPhoneDesktop> | undefined;
  const window = lifecycle.createWindow({
    iconPath: "",
    preloadPath: join(import.meta.dirname, "../preload/index.cjs"),
    logger,
    forceQuitRef,
    windowHostProcessMap: children,
    prepareLocalCore: async () => location,
    onHostProcessReady: () => attachment?.revokeWindow(window.id),
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
  attachment = pairedPhone.registerPairedPhoneDesktop({
    hosts: children,
    rendererRoot: join(import.meta.dirname, "../renderer"),
  });
  // 中文：Shell 侧栏会经 preload 调 zoom 档 IPC；fixture 只注册与生产同形的
  // sender-window 读取，不挂载整组平台 IPC。
  ipcMain.handle(PlatformChannels.GetDesktopZoomLevel, (event) => {
    const senderWindow = BrowserWindow.fromWebContents(event.sender);
    if (!senderWindow || senderWindow.isDestroyed()) return { zoomLevel: 0 };
    return {
      zoomLevel: resolveDesktopZoomLevelFromFactor(senderWindow.webContents.getZoomFactor()),
    };
  });
  window.once("closed", () => attachment?.revokeWindow(window.id));
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
    attachment?.dispose();
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
