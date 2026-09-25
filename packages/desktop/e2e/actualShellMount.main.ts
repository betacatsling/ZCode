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
  // Fixture initiates a *real* hierarchy creation on the mounted Core, never writes
  // Catalog rows/read-model facts. The renderer selects the returned Core session ID.
  (
    globalThis as typeof globalThis & { __actualShellCreateHistory?: () => Promise<string> }
  ).__actualShellCreateHistory = async () => {
    const read = await core.mountLocalCore(location);
    try {
      const hierarchy = read.services.get(services.IWorkspaceHierarchyService);
      const harness = (await hierarchy.listHarnesses("main")).find(
        (item) => item.manifest.id === "synthetic-history" && item.availability === "supported",
      );
      // Production UI's create-option chooser is deliberately Pi-only; fixture selects
      // the same validated local fake Model binding, then real hierarchy/Host checks it.
      const selection = (await hierarchy.listCreateOptions("main")).options.find(
        (item) => item.harnessId === "pi",
      );
      if (!harness || !selection)
        throw new Error("Trusted synthetic harness or fake Model binding unavailable from Core");
      const created = await hierarchy.createAgent({
        workspaceId: "main",
        harnessId: harness.manifest.id,
        modelBinding: selection.binding,
        commandId: crypto.randomUUID(),
      });
      if (created.owner.kind !== "external" || created.owner.historyOnly)
        throw new Error("Synthetic Host owner not writable");
      return created.owner.spec.hostSessionId;
    } finally {
      read.attachment.dispose();
    }
  };
  (
    globalThis as typeof globalThis & {
      __actualShellSendHistory?: (id: string) => Promise<unknown>;
    }
  ).__actualShellSendHistory = async (id) => {
    const read = await core.mountLocalCore(location);
    try {
      const agent = read.services.get(services.IAgentHostService);
      const spec = await agent.getSessionSpec({
        targetId: location.installationId,
        workspaceId: "main",
        hostSessionId: id,
      });
      if (!spec || spec.harness.id !== "synthetic-history")
        throw new Error("Foreign synthetic Host");
      const commandId = crypto.randomUUID();
      // 中文：RPC Promise 未落定前不能释放一次性 ticket，否则已接受发送只留下不确定回执。
      return await agent.dispatch(spec, {
        type: "send",
        commandId,
        hostSessionId: id,
        turnId: commandId,
        text: "Produce synthetic long history",
      });
    } finally {
      read.attachment.dispose();
    }
  };
  // Read-only durable Core event census: producer counters alone do not establish persisted kinds.
  (
    globalThis as typeof globalThis & {
      __actualShellCountHistory?: (id: string) => Promise<unknown>;
    }
  ).__actualShellCountHistory = async (id) => {
    const read = await core.mountLocalCore(location);
    try {
      const agent = read.services.get(services.IAgentHostService);
      const spec = await agent.getSessionSpec({
        targetId: location.installationId,
        workspaceId: "main",
        hostSessionId: id,
      });
      if (!spec || spec.harness.id !== "synthetic-history")
        throw new Error("Foreign synthetic Host");
      const kinds: Record<string, number> = {};
      let sequence = 0;
      while (true) {
        const batch = await agent.eventsSince(spec, sequence);
        if (!batch.length) break;
        for (const event of batch) {
          if (event.sequence !== sequence + 1)
            throw new Error(`Noncontiguous Core journal at ${sequence}`);
          sequence = event.sequence;
          kinds[event.kind] = (kinds[event.kind] ?? 0) + 1;
        }
        if (sequence > 102_000) throw new Error("Synthetic event cap exceeded");
      }
      return { sequence, kinds };
    } finally {
      read.attachment.dispose();
    }
  };
  (
    globalThis as typeof globalThis & {
      __actualShellCancelHistory?: (id: string) => Promise<unknown>;
    }
  ).__actualShellCancelHistory = async (id) => {
    const read = await core.mountLocalCore(location);
    try {
      const agent = read.services.get(services.IAgentHostService);
      const spec = await agent.getSessionSpec({
        targetId: location.installationId,
        workspaceId: "main",
        hostSessionId: id,
      });
      if (!spec || spec.harness.id !== "synthetic-history")
        throw new Error("Foreign synthetic Host");
      const started = (await agent.eventsSince(spec, 0)).find(
        (event) => event.kind === "turn.started",
      );
      if (!started || started.kind !== "turn.started")
        throw new Error("Original accepted turn not started");
      return await agent.dispatch(spec, {
        type: "cancelTurn",
        commandId: crypto.randomUUID(),
        hostSessionId: id,
        runtimeEpoch: started.runtimeEpoch,
        turnId: started.turnId,
      });
    } finally {
      read.attachment.dispose();
    }
  };
  (
    globalThis as typeof globalThis & {
      __actualShellTerminateHistory?: (id: string) => Promise<unknown>;
    }
  ).__actualShellTerminateHistory = async (id) => {
    const read = await core.mountLocalCore(location);
    try {
      const agent = read.services.get(services.IAgentHostService);
      const spec = await agent.getSessionSpec({
        targetId: location.installationId,
        workspaceId: "main",
        hostSessionId: id,
      });
      if (!spec || spec.harness.id !== "synthetic-history")
        throw new Error("Foreign synthetic Host");
      return await agent.dispatch(spec, {
        type: "terminateSession",
        commandId: crypto.randomUUID(),
        hostSessionId: id,
      });
    } finally {
      read.attachment.dispose();
    }
  };
  (
    globalThis as typeof globalThis & {
      __actualShellHistory?: (id: string, beforeRowId?: number) => Promise<unknown>;
    }
  ).__actualShellHistory = async (id, beforeRowId) => {
    const read = await core.mountLocalCore(location);
    try {
      const agent = read.services.get(services.IAgentHostService);
      const spec = await agent.getSessionSpec({
        targetId: location.installationId,
        workspaceId: "main",
        hostSessionId: id,
      });
      if (!spec || spec.harness.id !== "synthetic-history")
        throw new Error("Foreign or missing synthetic Host");
      const model = await agent.getSessionReadModel(spec);
      const result = await agent.rowsRange(spec, {
        sessionId: id,
        ...(beforeRowId ? { beforeRowId } : {}),
        limit: 200,
      });
      return { model, result };
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
