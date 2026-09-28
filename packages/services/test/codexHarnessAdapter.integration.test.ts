import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import type { Model, ModelRequest } from "@zcode/contracts";
import { CodexHarnessAdapter } from "../src/agent-adapters/codex/codexHarnessAdapter.js";
import { CodexAppServerProcess } from "../src/agent-adapters/codex/codexAppServerProcess.js";
import {
  codexSessionProfileRoot,
  resolveCodexExecutable,
} from "../src/agent-adapters/codex/codexProfile.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import type { AgentEvent, BindingPlan, SessionSpec } from "@zcode/shared/agent-host";
import { createCodexHarnessFakeModel } from "./fixtures/codexHarnessFakeModel.js";

const PINNED_CLI_TEST = process.env.ZCODE_CODEX_ADAPTER_TEST === "1";

test(
  "pinned Codex app-server runs through HarnessAdapter, SessionHost and loopback Gateway with only a Fake Model",
  {
    skip: !PINNED_CLI_TEST,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-harness-adapter-"));
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const adapterRoot = join(root, "adapter-data");
    const journalRoot = join(root, "host-journal");
    await Promise.all(
      [workspaceA, workspaceB].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
    );
    const executablePath = await resolveCodexExecutable(process.env.ZCODE_CODEX_EXECUTABLE);
    const fake = createCodexHarnessFakeModel({
      allow: join(root, "unused-allow.txt"),
      deny: join(root, "unused-deny.txt"),
    });
    let catalogRevision = 1;
    const routeCalls: Record<"v1" | "v2", string[]> = { v1: [], v2: [] };
    const routeContexts: Record<"v1" | "v2", unknown[]> = { v1: [], v2: [] };
    const routeModelStarted = deferred<void>();
    const releaseRouteModel = deferred<void>();
    const makeRouteModel = (route: "v1" | "v2"): Model =>
      ({
        ...fake.model,
        async *streamText(request: ModelRequest) {
          const lastUser = [...request.messages]
            .reverse()
            .find((message) => message.role === "user");
          const userText = lastUser ? messageText(lastUser.content) : "";
          routeCalls[route].push(userText);
          routeContexts[route].push(structuredClone(request.messages));
          if (route === "v1" && userText.includes("WAIT_FOR_ROUTE_CHANGE")) {
            routeModelStarted.resolve();
            await releaseRouteModel.promise;
          }
          yield* fake.model.streamText(request);
        },
      }) as unknown as Model;
    const routeModels = { v1: makeRouteModel("v1"), v2: makeRouteModel("v2") };
    const routeModelFactory = (_spec: SessionSpec, plan: BindingPlan) =>
      plan.catalogFingerprint === "fixture-catalog-v1" ? routeModels.v1 : routeModels.v2;
    const processes = new Map<string, CodexAppServerProcess>();
    const stderr = new Map<string, string>();
    const clock = { now: Date.now() };
    let bindingCurrent = true;
    const bindingGuard = { now: () => clock.now, isSelectionAuthorized: () => bindingCurrent };
    const adapter = createAdapter(
      adapterRoot,
      executablePath,
      fake.model,
      processes,
      "danger-full-access",
      stderr,
      { ...bindingGuard, modelFactory: routeModelFactory },
    );
    const registry = new HarnessRegistry();
    registry.register(adapter);
    const catalog = {
      get fingerprint() {
        return `fixture-catalog-v${catalogRevision}`;
      },
      validateSelection: () => ({ ok: true as const }),
      capture() {
        const capturedRevision = catalogRevision;
        return {
          fingerprint: `fixture-catalog-v${capturedRevision}`,
          validateSelection: () => ({ ok: true as const }),
          isCurrent: () => catalogRevision === capturedRevision,
          credentialSource: () => "provider-api-key" as const,
        };
      },
    };
    const target = {
      id: "codex-test-target",
      kind: "local" as const,
      platform: process.platform as "darwin" | "linux" | "win32",
      available: true,
    };
    const specA = sessionSpec("codex-session-a", workspaceA);
    const specB = sessionSpec("codex-session-b", workspaceB);
    let hostA!: SessionHost;
    let hostB!: SessionHost;
    const hosts = new Set<SessionHost>();
    let activeAdapter = adapter;
    t.after(async () => {
      for (const host of hosts) {
        try {
          await host.close();
        } catch {
          /* cleanup after an asserted unknown turn */
        }
      }
      await activeAdapter.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    try {
      hostA = await SessionHost.create({
        root: journalRoot,
        spec: specA,
        target,
        catalog,
        registry,
      });
      hosts.add(hostA);
      hostB = await SessionHost.create({
        root: journalRoot,
        spec: specB,
        target,
        catalog,
        registry,
      });
      hosts.add(hostB);
    } catch (error) {
      t.diagnostic(`Codex startup stderr: ${safeStderr(stderr, root)}`);
      throw error;
    }

    assert.notEqual(hostA.binding.backendSessionId, hostB.binding.backendSessionId);
    t.diagnostic("two isolated Codex app-server threads started with per-session Gateway grants");

    await sendAndWait(hostA, "turn-a-text", "Say hello through the fake model.");
    assert.ok(
      hostA
        .eventsSince(0)
        .some(
          (event) =>
            event.kind === "message.finished" &&
            event.role === "assistant" &&
            event.text === "gateway text ok",
        ),
    );
    await sendAndWait(hostB, "turn-b-text", "A second session stays isolated.");
    assert.ok(
      hostB
        .eventsSince(0)
        .some((event) => event.kind === "message.finished" && event.role === "assistant"),
    );

    const activeCatalogUpdate = await hostA.dispatch(
      sendCommand(
        specA.hostSessionId,
        "turn-a-active-catalog-update",
        "WAIT_FOR_ROUTE_CHANGE",
        "send-a-active-catalog-update",
      ),
    );
    assert.equal(activeCatalogUpdate.status, "accepted");
    await routeModelStarted.promise;
    catalogRevision = 2;
    await hostA.whenEventsSettled();
    assert.equal(hostA.summary().lastKnownStatus, "running");
    assert.equal(
      hostA
        .eventsSince(0)
        .some((event) => event.kind === "session.error" && event.code === "stale-model-binding"),
      false,
      "an unrelated idle catalog update cannot replace or kill the active turn binding",
    );
    releaseRouteModel.resolve();
    await hostA.whenIdle();
    assert.equal(
      hostA.queryBindingFact("send-a-active-catalog-update")?.catalogFingerprint,
      "fixture-catalog-v1",
    );
    assert.equal(routeCalls.v1.includes("WAIT_FOR_ROUTE_CHANGE"), true);
    assert.equal(routeCalls.v2.length, 0);
    const hostAThread = hostA.binding.backendSessionId;
    const traceBeforeRebind = fake.trace.length;
    await sendAndWait(hostA, "turn-a-idle-catalog-rebind", "Continue after the catalog update.");
    assert.equal(hostA.binding.backendSessionId, hostAThread);
    assert.equal(hostA.queryCommand("send-turn-a-idle-catalog-rebind")?.status, "completed");
    assert.equal(
      hostA.queryBindingFact("send-turn-a-idle-catalog-rebind")?.catalogFingerprint,
      "fixture-catalog-v2",
    );
    assert.equal(fake.trace.length, traceBeforeRebind + 1);
    assert.equal(routeCalls.v2.at(-1), "Continue after the catalog update.");
    assert.equal(
      JSON.stringify(routeContexts.v2.at(-1)).includes("WAIT_FOR_ROUTE_CHANGE"),
      true,
      "idle thread/resume must preserve the prior turn context without replaying its prompt",
    );

    await sendAndWait(hostA, "turn-a-tools", "RUN_MULTI_TOOLS");
    assert.equal(await readFile(join(workspaceA, "multi-a.txt"), "utf8"), "alpha");
    assert.equal(await readFile(join(workspaceA, "multi-b.txt"), "utf8"), "beta");
    const pairedHistory = fake.trace.find((entry) =>
      entry.messages.some(
        (message) => message.role === "assistant" && message.toolCalls?.length === 2,
      ),
    );
    assert.ok(
      pairedHistory,
      "Gateway must return adjacent function calls as one assistant toolCalls batch",
    );
    assert.ok(
      pairedHistory.messages.some(
        (message) =>
          message.role === "assistant" &&
          messageText(message.content).includes("Running two fixed local commands."),
      ),
    );
    assert.equal(pairedHistory.toolOutputs.length, 2);
    t.diagnostic(
      "Codex completed a two-call Responses tool roundtrip and the Gateway retained visible assistant text",
    );

    await sendAndWait(hostA, "turn-a-token-check", "CHECK_TOKEN_ISOLATION");
    const tokenCheck = fake.trace.find(
      (entry) => entry.userText.includes("CHECK_TOKEN_ISOLATION") && entry.toolOutputs.length > 0,
    );
    assert.ok(tokenCheck?.toolOutputs.some((output) => output.includes("token-absent")));
    assert.equal(
      tokenCheck?.toolOutputs.some((output) => output.includes("token-exposed")),
      false,
    );

    const cancelStarted = waitForEvent(
      hostA,
      (event) => event.kind === "turn.started" && event.turnId === "turn-a-cancel",
    );
    await hostA.dispatch(
      sendCommand(specA.hostSessionId, "turn-a-cancel", "WAIT_FOR_CANCEL", "send-a-cancel"),
    );
    await cancelStarted;
    await fake.waitForCancelStart(1);
    const cancelled = await hostA.dispatch({
      type: "cancelTurn",
      commandId: "cancel-a-cancel",
      hostSessionId: specA.hostSessionId,
      runtimeEpoch: hostA.binding.runtimeEpoch,
      turnId: "turn-a-cancel",
    });
    assert.equal(cancelled.status, "completed");
    await fake.waitForCancelObserved(1);
    await hostA.whenIdle();
    assert.ok(
      hostA
        .eventsSince(0)
        .some(
          (event) =>
            event.kind === "turn.finished" &&
            event.turnId === "turn-a-cancel" &&
            event.outcome === "cancelled",
        ),
    );
    assert.ok(
      fake.trace
        .filter((entry) => entry.userText.includes("WAIT_FOR_CANCEL"))
        .every((entry) => entry.abortSignalPassed),
    );
    t.diagnostic(
      "turn/interrupt matched the active backend turn and aborted the Fake Model stream",
    );

    const historyBeforeRestart = hostA.snapshot();
    const backendThreadIdBeforeRestart = hostA.binding.backendSessionId;
    const traceCountBeforeResume = fake.trace.length;
    await hostA.close();
    hosts.delete(hostA);
    const storedHistory = await SessionHost.snapshotHistory(journalRoot, specA);
    assert.equal(storedHistory.seq, historyBeforeRestart.seq);
    await adapter.terminate(specA.hostSessionId);
    await hostB.close();
    hosts.delete(hostB);
    await adapter.shutdown();

    const resumedAdapter = createAdapter(
      adapterRoot,
      executablePath,
      fake.model,
      processes,
      "danger-full-access",
      new Map(),
      { ...bindingGuard, modelFactory: routeModelFactory },
    );
    activeAdapter = resumedAdapter;
    const resumedRegistry = new HarnessRegistry();
    resumedRegistry.register(resumedAdapter);
    hostA = await SessionHost.open({
      root: journalRoot,
      spec: specA,
      target,
      catalog,
      registry: resumedRegistry,
    });
    hosts.add(hostA);
    assert.equal(hostA.binding.backendSessionId, backendThreadIdBeforeRestart);
    assert.equal(hostA.plan.capabilities.history?.support, "experimental");
    assert.equal(hostA.plan.capabilities.resumeExecution?.support, "unsupported");
    assert.match(
      hostA.plan.capabilities.resumeExecution?.reason ?? "",
      /uncertain in-flight turns are never replayed/,
    );
    assert.ok(hostA.snapshot().seq >= storedHistory.seq);
    assert.equal(
      fake.trace.length,
      traceCountBeforeResume,
      "thread/resume must not replay an accepted prompt",
    );
    t.diagnostic("thread/resume restored the opaque backend thread without a second Model request");

    const beforeStaleBinding = fake.trace.length;
    bindingCurrent = false;
    const staleReceipt = await hostA.dispatch(
      sendCommand(
        specA.hostSessionId,
        "turn-stale-binding",
        "Do not reach the old Model",
        "send-stale-binding",
      ),
    );
    assert.equal(staleReceipt.status, "rejected");
    assert.equal(staleReceipt.reasonCode, "invalid-binding");
    assert.equal(
      fake.trace.length,
      beforeStaleBinding,
      "an explicitly revoked model selection must be rejected before acceptance or Model calls",
    );
    await hostA.close();
    hosts.delete(hostA);
    const staleHistory = await SessionHost.snapshotHistory(journalRoot, specA);
    assert.ok(staleHistory.seq >= storedHistory.seq);
    bindingCurrent = true;

    clock.now = Date.now();
    hostB = await SessionHost.open({
      root: journalRoot,
      spec: specB,
      target,
      catalog,
      registry: resumedRegistry,
    });
    hosts.add(hostB);
    const threadBeforeRenewal = hostB.binding.backendSessionId;
    const beforeExpiredGrant = fake.trace.length;
    clock.now = Date.now() + 11 * 60_000;
    await sendAndWait(hostB, "turn-expired-grant", "Continue after the short grant lifetime.");
    assert.equal(hostB.queryCommand("send-turn-expired-grant")?.status, "completed");
    assert.equal(
      fake.trace.length,
      beforeExpiredGrant + 1,
      "same-binding renewal must authorize the next turn without a GUI or prompt replay",
    );
    assert.equal(hostB.binding.backendSessionId, threadBeforeRenewal);
    assert.equal(
      fake.trace
        .at(-1)
        ?.messages.some(
          (message) =>
            message.role === "user" &&
            messageText(message.content).includes("A second session stays isolated."),
        ),
      true,
      "the renewed grant keeps the existing Codex thread history",
    );

    const beforeCatalogRebind = fake.trace.length;
    catalogRevision += 1;
    const threadBeforeRebind = hostB.binding.backendSessionId;
    await sendAndWait(hostB, "turn-catalog-rebind", "Continue after the catalog route revision.");
    assert.equal(hostB.queryCommand("send-turn-catalog-rebind")?.status, "completed");
    assert.equal(hostB.binding.backendSessionId, threadBeforeRebind);
    assert.equal(fake.trace.length, beforeCatalogRebind + 1);
    assert.equal(
      hostB.queryBindingFact("send-turn-catalog-rebind")?.catalogFingerprint,
      "fixture-catalog-v3",
    );
    t.diagnostic(
      "same-binding renewal and idle catalog rebind resumed the same native thread without prompt replay",
    );
    await hostB.close();
    hosts.delete(hostB);
    const expiredHistory = await SessionHost.snapshotHistory(journalRoot, specB);
    await resumedAdapter.shutdown();

    clock.now = Date.now();
    const recoveryAdapter = createAdapter(
      adapterRoot,
      executablePath,
      fake.model,
      processes,
      "danger-full-access",
      new Map(),
      { ...bindingGuard, modelFactory: routeModelFactory },
    );
    activeAdapter = recoveryAdapter;
    const recoveryRegistry = new HarnessRegistry();
    recoveryRegistry.register(recoveryAdapter);
    hostB = await SessionHost.open({
      root: journalRoot,
      spec: specB,
      target,
      catalog,
      registry: recoveryRegistry,
    });
    hosts.add(hostB);
    assert.ok(hostB.snapshot().seq >= expiredHistory.seq);
    assert.equal(hostB.plan.catalogFingerprint, "fixture-catalog-v3");
    assert.equal(fake.trace.length, beforeCatalogRebind + 1);
    await hostB.close();
    hosts.delete(hostB);
    t.diagnostic("cold attach kept the rebound Host history without another Model request");

    const workspaceCrash = join(root, "workspace-crash");
    await mkdir(workspaceCrash, { mode: 0o700 });
    const specCrash = sessionSpec("codex-session-crash", workspaceCrash);
    const crashHost = await SessionHost.create({
      root: journalRoot,
      spec: specCrash,
      target,
      catalog,
      registry: recoveryRegistry,
    });
    hosts.add(crashHost);
    const crashStarted = waitForEvent(
      crashHost,
      (event) => event.kind === "turn.started" && event.turnId === "turn-crash",
    );
    await crashHost.dispatch(
      sendCommand(specCrash.hostSessionId, "turn-crash", "WAIT_FOR_CANCEL", "send-crash"),
    );
    await crashStarted;
    await fake.waitForCancelStart(2);
    const crashingProcess = processes.get(specCrash.hostSessionId);
    assert.ok(crashingProcess?.child.pid);
    crashingProcess.child.kill("SIGKILL");
    await crashingProcess.closed;
    await fake.waitForCancelObserved(2);
    await crashHost.whenIdle();
    assert.equal(crashHost.queryCommand("send-crash")?.status, "execution-unknown");
    assert.ok(
      crashHost
        .eventsSince(0)
        .some(
          (event) =>
            event.kind === "turn.finished" &&
            event.turnId === "turn-crash" &&
            event.outcome === "unknown",
        ),
    );
    t.diagnostic("unexpected app-server exit recorded an uncertain send and did not replay it");
  },
);

test(
  "pinned Codex renews its Host turn lease after an offline long tool before the next Model request",
  { skip: !PINNED_CLI_TEST, timeout: 30_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-turn-lease-"));
    const workspace = join(root, "workspace");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const script = join(workspace, "hold-tool.mjs");
    const release = join(workspace, "release-tool");
    const started = join(workspace, "tool-started");
    const finished = join(workspace, "tool-finished");
    await writeFile(
      script,
      [
        'import { watch } from "node:fs";',
        'import { basename, dirname } from "node:path";',
        'import { access, writeFile } from "node:fs/promises";',
        "const [release, started, finished] = process.argv.slice(2);",
        'await writeFile(started, "started");',
        "await new Promise((resolve) => {",
        "  const watcher = watch(dirname(release), async (_event, name) => {",
        "    if (name?.toString() !== basename(release)) return;",
        "    try { await access(release); watcher.close(); resolve(); } catch { /* wait for release */ }",
        "  });",
        "});",
        'process.stdout.write("long-tool-released");',
        'await writeFile(finished, "finished");',
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    const executablePath = await resolveCodexExecutable(process.env.ZCODE_CODEX_EXECUTABLE);
    const fake = createCodexHarnessFakeModel({
      allow: join(root, "unused-allow.txt"),
      deny: join(root, "unused-deny.txt"),
      longTool: { script, release, started, finished },
    });
    const clock = { now: Date.now() };
    const adapter = createAdapter(
      join(root, "adapter-data"),
      executablePath,
      fake.model,
      new Map(),
      "danger-full-access",
      new Map(),
      { now: () => clock.now, isBindingCurrent: () => true },
    );
    const registry = new HarnessRegistry();
    registry.register(adapter);
    const spec = sessionSpec("codex-long-tool-lease", workspace);
    const target = {
      id: "codex-test-target",
      kind: "local" as const,
      platform: process.platform as "darwin" | "linux" | "win32",
      available: true,
    };
    const catalog = {
      fingerprint: "codex-long-tool-catalog-v1",
      validateSelection: () => ({ ok: true as const }),
    };
    const command = `node '${script}' '${release}' '${started}'`;
    const profileRules = join(
      codexSessionProfileRoot(join(root, "adapter-data"), spec),
      "codex-home",
      "rules",
    );
    await mkdir(profileRules, { recursive: true, mode: 0o700 });
    await writeFile(
      join(profileRules, "default.rules"),
      [
        "prefix_rule(",
        `    pattern = ["/bin/bash", "-c", ${JSON.stringify(command)}],`,
        '    decision = "prompt",',
        '    justification = "The isolated long-tool fixture requires an explicit Host approval.",',
        ")",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    let host: SessionHost | undefined;
    const approvals: Array<Promise<void>> = [];
    const releaseIfNeeded = async () => {
      await writeFile(release, "released").catch(() => undefined);
      await Promise.allSettled(approvals);
    };
    t.after(async () => {
      await releaseIfNeeded();
      try {
        await host?.whenIdle();
      } catch {
        /* An assertion below owns the reported failure. */
      }
      try {
        await host?.close();
      } catch {
        /* Isolated active-turn cleanup after an assertion. */
      }
      await adapter.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    host = await SessionHost.create({
      root: join(root, "journal"),
      spec,
      target,
      catalog,
      registry,
    });
    const stopApproval = resolveApprovals(host, "allow", approvals);
    const receipt = await host.dispatch(
      sendCommand(spec.hostSessionId, "turn-long-tool", "LONG_TOOL", "send-long-tool"),
    );
    assert.equal(receipt.status, "accepted");
    await waitForFile(started);

    // The target Host renews the matching active turn lease while no GUI is attached.
    clock.now += 11 * 60_000;
    assert.ok(adapter.renewTurnLease(spec.hostSessionId, "turn-long-tool").expiresAt > clock.now);
    await writeFile(release, "released");
    await host.whenIdle();
    stopApproval();

    assert.equal(host.queryCommand("send-long-tool")?.status, "completed");
    assert.equal(
      fake.trace.filter((entry) => entry.userText.includes("LONG_TOOL")).length,
      2,
      "Codex must issue the post-tool Model request under the renewed turn lease",
    );
    assert.equal(await readFile(finished, "utf8"), "finished");
    assert.equal(
      host
        .eventsSince(0)
        .filter(
          (event) =>
            event.kind === "message.finished" &&
            event.role === "user" &&
            event.text === "LONG_TOOL",
        ).length,
      1,
      "the existing Codex thread accepts one prompt and retains tool context without replay",
    );
  },
);

test(
  "pinned Codex waits for matching Host allow and deny RPC decisions before fixed commands",
  {
    skip: !PINNED_CLI_TEST,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-approval-adapter-"));
    const workspace = join(root, "workspace");
    const allowedWrite = join(root, "approved-outside-workspace.txt");
    const deniedWrite = join(root, "denied-outside-workspace.txt");
    const racedWrite = join(root, "raced-outside-workspace.txt");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const executablePath = await resolveCodexExecutable(process.env.ZCODE_CODEX_EXECUTABLE);
    const fake = createCodexHarnessFakeModel({
      allow: allowedWrite,
      deny: deniedWrite,
      race: racedWrite,
    });
    const stderr = new Map<string, string>();
    const adapterRoot = join(root, "adapter-data");
    // A per-session prompt rule exercises the real app-server approval RPC despite the container's unavailable workspace-write socket mount.
    // This fixed temporary command fixture does not certify sandbox confinement or arbitrary user commands.
    const adapter = createAdapter(
      adapterRoot,
      executablePath,
      fake.model,
      new Map(),
      "danger-full-access",
      stderr,
    );
    const registry = new HarnessRegistry();
    registry.register(adapter);
    const spec = sessionSpec("codex-approval-session", workspace);
    const target = {
      id: "codex-test-target",
      kind: "local" as const,
      platform: process.platform as "darwin" | "linux" | "win32",
      available: true,
    };
    const catalog = {
      fingerprint: "approval-catalog",
      validateSelection: () => ({ ok: true as const }),
    };
    let host: SessionHost | undefined;
    const disposers: Array<() => void> = [];
    t.after(async () => {
      for (const dispose of disposers) dispose();
      try {
        await host?.close();
      } catch {
        /* cleanup after a failed approval gate */
      }
      await adapter.shutdown();
      await rm(root, { recursive: true, force: true });
    });
    const profileRules = join(codexSessionProfileRoot(adapterRoot, spec), "codex-home", "rules");
    await mkdir(profileRules, { recursive: true, mode: 0o700 });
    const rule = (command: string) =>
      [
        "prefix_rule(",
        `    pattern = ["/bin/bash", "-c", ${JSON.stringify(command)}],`,
        '    decision = "prompt",',
        '    justification = "The isolated fixture requires an explicit Host approval.",',
        ")",
        "",
      ].join("\n");
    await writeFile(
      join(profileRules, "default.rules"),
      rule(`printf approved > '${allowedWrite}'`) +
        rule(`printf denied > '${deniedWrite}'`) +
        rule(`printf raced > '${racedWrite}'`),
      { mode: 0o600 },
    );
    try {
      host = await SessionHost.create({
        root: join(root, "journal"),
        spec,
        target,
        catalog,
        registry,
      });
    } catch (error) {
      t.diagnostic(`Codex startup stderr: ${safeStderr(stderr, root)}`);
      throw error;
    }
    const allowResolutions: Array<Promise<void>> = [];
    const disposeAllow = resolveApprovals(host, "allow", allowResolutions);
    disposers.push(disposeAllow);
    await sendAndWait(host, "turn-approval-allow", "ALLOW_FIXED_WRITE");
    disposeAllow();
    await Promise.all(allowResolutions);
    assert.equal(await readFile(allowedWrite, "utf8"), "approved");

    const deniedResolutions: Array<Promise<void>> = [];
    const disposeDeny = resolveApprovals(host, "deny", deniedResolutions);
    disposers.push(disposeDeny);
    await sendAndWait(host, "turn-approval-deny", "DENY_FIXED_WRITE");
    disposeDeny();
    await Promise.all(deniedResolutions);
    await assert.rejects(access(deniedWrite));
    const racingReceipts: Array<
      Promise<{ readonly decision: "allow" | "deny"; readonly status: string }>
    > = [];
    let raceCommand = 0;
    const stopRaceApproval = host.subscribe((event) => {
      if (event.kind !== "interaction.requested") return;
      for (const decision of ["allow", "deny"] as const) {
        const commandId = `resolve-race-${decision}-${++raceCommand}`;
        racingReceipts.push(
          host
            .dispatch({
              type: "resolveInteraction",
              commandId,
              hostSessionId: host.spec.hostSessionId,
              runtimeEpoch: host.binding.runtimeEpoch,
              turnId: event.turnId,
              interactionId: event.interactionId,
              decision,
            })
            .then((receipt) => ({ decision, status: receipt.status })),
        );
      }
    });
    await sendAndWait(host, "turn-approval-race", "RACE_FIXED_WRITE");
    stopRaceApproval();
    const raced = await Promise.all(racingReceipts);
    assert.equal(raced.filter((receipt) => receipt.status === "completed").length, 1);
    assert.equal(raced.filter((receipt) => receipt.status === "rejected").length, 1);
    const winningDecision = host
      .eventsSince(0)
      .find(
        (event) => event.kind === "interaction.resolved" && event.turnId === "turn-approval-race",
      );
    assert.ok(winningDecision);
    if (winningDecision.decision === "allow")
      assert.equal(await readFile(racedWrite, "utf8"), "raced");
    else await assert.rejects(access(racedWrite));
    const events = host.eventsSince(0);
    assert.ok(events.filter((event) => event.kind === "interaction.requested").length >= 3);
    assert.ok(
      events.some((event) => event.kind === "interaction.resolved" && event.decision === "allow"),
    );
    assert.ok(
      events.some((event) => event.kind === "interaction.resolved" && event.decision === "deny"),
    );
    assert.ok(
      deniedResolutions.length > 0 && allowResolutions.length > 0,
      "the backend must hold each matching JSON-RPC request for the Host decision",
    );
  },
);

test(
  "Codex JSON-RPC process answers an unknown server request with an unsupported error",
  {
    skip: process.platform === "win32",
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-rpc-fixture-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const scriptPath = join(root, "fake-codex.mjs");
    await writeFile(
      scriptPath,
      `#!/usr/bin/env node
import readline from 'node:readline';
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send({ id: request.id, result: {} });
  if (request.method === 'initialized') send({ id: 'unknown-request-1', method: 'codex/unknownCapability', params: {} });
  if (request.id === 'unknown-request-1' && request.error?.code === -32601) send({ method: 'fixture/rejected', params: { code: request.error.code } });
  if (request.method === 'hang') { /* deliberately withhold the response */ }
});
`,
      { mode: 0o700 },
    );
    const profile = join(root, "profile");
    await mkdir(profile, { mode: 0o700 });
    let connection: CodexAppServerProcess | undefined;
    let rejected!: (code: number) => void;
    let processFailure: Error | undefined;
    const unknownRejected = new Promise<number>((resolve) => {
      rejected = resolve;
    });
    t.after(async () => {
      await connection?.terminate();
    });
    connection = await CodexAppServerProcess.launch({
      executablePath: scriptPath,
      cwd: root,
      env: { PATH: process.env.PATH, HOME: profile, CODEX_HOME: profile, TMPDIR: profile },
      onNotification(method, params) {
        if (method === "fixture/rejected" && isRecord(params) && typeof params.code === "number")
          rejected(params.code);
      },
      async onServerRequest(message) {
        assert.equal(message.method, "codex/unknownCapability");
        if (typeof message.id !== "string" && typeof message.id !== "number")
          throw new Error("missing JSON-RPC id");
        await connection!.rejectServerRequest(
          message.id,
          -32601,
          "Unsupported Codex app-server request",
        );
      },
      onFailure(error) {
        processFailure = error;
      },
    });
    await connection.request("initialize", {});
    await connection.notify("initialized", {});
    assert.equal(await unknownRejected, -32601);
    await assert.rejects(
      connection.request("hang", {}, 25),
      /timed out; execution outcome is unknown/,
    );
    await connection.closed;
    assert.match(processFailure?.message ?? "", /timed out/);
    await connection.terminate();
  },
);

function createAdapter(
  root: string,
  executablePath: string,
  model: ReturnType<typeof createCodexHarnessFakeModel>["model"],
  processes: Map<string, CodexAppServerProcess>,
  sandboxMode: "workspace-write" | "danger-full-access" = "danger-full-access",
  stderr = new Map<string, string>(),
  guards: {
    now?: () => number;
    isSelectionAuthorized?: () => boolean;
    modelFactory?: (spec: SessionSpec, plan: BindingPlan) => Model;
  } = {},
): CodexHarnessAdapter {
  return new CodexHarnessAdapter({
    root,
    executablePath,
    sandboxMode,
    isOpenAiResponsesSelection: () => true,
    fakeModelCompatibilityEvidence: (selection) =>
      selection.providerId === "fake-provider" && selection.modelId === "fake-model"
        ? {
            providerId: "fake-provider",
            modelId: "fake-model",
            fixtureId: "codex-harness-fake-model",
          }
        : undefined,
    ...(guards.now ? { now: guards.now } : {}),
    ...(guards.isSelectionAuthorized
      ? { isSelectionAuthorized: guards.isSelectionAuthorized }
      : {}),
    modelFactory: guards.modelFactory ?? (() => model),
    onProcess: (hostSessionId, process) => processes.set(hostSessionId, process),
    onStderr: (hostSessionId, chunk) =>
      stderr.set(hostSessionId, (stderr.get(hostSessionId) ?? "") + chunk),
  });
}

function safeStderr(stderr: Map<string, string>, root: string): string {
  return JSON.stringify(
    [...stderr].map(([session, text]) => [
      session,
      text
        .replaceAll(root, "<temp>")
        .replace(/Bearer [A-Za-z0-9_-]+/g, "Bearer <redacted>")
        .slice(-4096),
    ]),
  );
}

function sessionSpec(hostSessionId: string, worktreePath: string) {
  return {
    schemaVersion: 1 as const,
    hostSessionId,
    execution: {
      targetId: "codex-test-target",
      workspaceIdentity: `identity-${hostSessionId}`,
      worktreePath,
    },
    harness: { id: "codex", adapterVersion: "0.157.1" },
    modelBinding: {
      kind: "host-managed" as const,
      selection: {
        providerId: "fake-provider" as never,
        modelId: "fake-model" as never,
        options: { reasoningLevel: "off" },
      },
    },
  };
}

function sendCommand(
  hostSessionId: string,
  turnId: string,
  text: string,
  commandId = randomUUID(),
) {
  return { type: "send" as const, commandId, hostSessionId, turnId, text };
}

async function sendAndWait(host: SessionHost, commandId: string, text: string): Promise<void> {
  const receipt = await host.dispatch(
    sendCommand(host.spec.hostSessionId, commandId, text, `send-${commandId}`),
  );
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
  await host.whenIdle();
  assert.equal(host.queryCommand(`send-${commandId}`)?.status, "completed");
}

function resolveApprovals(
  host: SessionHost,
  decision: "allow" | "deny",
  commands: Array<Promise<void>>,
): () => void {
  let index = 0;
  return host.subscribe((event) => {
    if (event.kind !== "interaction.requested") return;
    const commandId = `resolve-approval-${decision}-${++index}`;
    const resolution = host
      .dispatch({
        type: "resolveInteraction",
        commandId,
        hostSessionId: host.spec.hostSessionId,
        runtimeEpoch: host.binding.runtimeEpoch,
        turnId: event.turnId,
        interactionId: event.interactionId,
        decision,
      })
      .then((receipt) => {
        assert.equal(receipt.status, "completed");
      });
    commands.push(resolution);
  });
}

function waitForEvent(
  host: SessionHost,
  predicate: (event: AgentEvent) => boolean,
): Promise<AgentEvent> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = host.subscribe((event) => {
      if (!predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function waitForFile(path: string): Promise<void> {
  try {
    await access(path);
    return;
  } catch {
    // Install an explicit filesystem event waiter below; no polling interval is needed.
  }
  await new Promise<void>((resolve, reject) => {
    const watcher = watch(dirname(path), { persistent: false }, (_event, filename) => {
      if (filename?.toString() !== basename(path)) return;
      void access(path).then(
        () => {
          watcher.close();
          resolve();
        },
        () => undefined,
      );
    });
    watcher.once("error", (error) => {
      watcher.close();
      reject(error);
    });
    void access(path).then(
      () => {
        watcher.close();
        resolve();
      },
      () => undefined,
    );
  });
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isRecord(part) && part.type === "text")
    .map((part) => (part as { text: string }).text)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
