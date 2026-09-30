import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentEvent, ExecutionTarget, SessionSpec } from "@zcode/shared/agent-host";
import type { ProviderRegistryService } from "@zcode/provider";
import { TargetModelGateway } from "../src/model-gateway/index.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { createExperimentalRegistryClaudeHarness } from "../src/agent-adapters/claude/createClaudeHarness.js";
import {
  claudeSessionProfileRoot,
  createClaudeChildEnvironment,
} from "../src/agent-adapters/claude/claudeProfile.js";
import {
  PINNED_CLAUDE_CLI_VERSION,
  resolveClaudeExecutable,
} from "../src/agent-adapters/claude/claudeExecutable.js";
import { CLAUDE_PUBLIC_MODEL_ID } from "../src/agent-adapters/claude/claudeHarnessAdapter.js";
import type { ClaudeStreamProcess } from "../src/agent-adapters/claude/claudeStreamProcess.js";
import {
  createClaudeHarnessFakeModel,
  deferred,
  type ClaudeHarnessFakeModel,
  type ClaudeHarnessFakePaths,
} from "./fixtures/claudeHarnessFakeModel.js";

const RUN_PINNED_CLAUDE = process.env.ZCODE_CLAUDE_ADAPTER_TEST === "1";
const CLAUDE_TARGET_ID = "claude-local-test-target";
const PROVIDER_ID = "claude-fixture-provider";
const MODEL_ID = "claude-fixture-model";

test(
  "Claude Code 2.1.263 runs through HarnessAdapter, SessionHost, Messages Gateway and loopback FakeModel",
  { skip: !RUN_PINNED_CLAUDE, timeout: 360_000 },
  async (t) => {
    if (process.platform !== "linux") {
      t.skip("the pinned egress trace gate uses Linux strace");
      return;
    }
    try {
      await access("/usr/bin/strace", constants.X_OK);
    } catch {
      t.skip("the pinned egress trace gate requires /usr/bin/strace");
      return;
    }
    const root = await mkdtemp(join(tmpdir(), "zcode-claude-harness-adapter-"));
    const workspaceA = join(root, "workspace-a");
    const workspaceB = join(root, "workspace-b");
    const adapterRoot = join(root, "adapter-data");
    const journalRoot = join(root, "host-journal");
    const logRoot = "/tmp/zcode-gpt6-claude-messages";
    await mkdir(logRoot, { recursive: true, mode: 0o700 });
    await Promise.all(
      [workspaceA, workspaceB, adapterRoot, journalRoot].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
    const executable = await resolveClaudeExecutable(process.env.ZCODE_CLAUDE_EXECUTABLE);
    const traceBase = join(logRoot, `claude-2.1.263-connect-${randomUUID()}`);
    const tracedExecutable = await createStraceWrapper(root, executable, traceBase);
    const paths: ClaudeHarnessFakePaths = {
      workspace: workspaceA,
      allowedWrite: join(workspaceA, "allowed-once.txt"),
      deniedWrite: join(workspaceA, "denied-never.txt"),
      multiWriteA: join(workspaceA, "multi-a.txt"),
      multiWriteB: join(workspaceA, "multi-b.txt"),
    };
    const routeChange = { started: deferred<void>(), release: deferred<void>() };
    const longLease = { started: deferred<void>(), release: deferred<void>() };
    const controls = {
      cancelStarted: deferred<void>(),
      unknownStarted: deferred<void>(),
      abortObserved: deferred<void>(),
    };
    const fakeV1 = createClaudeHarnessFakeModel({ routeId: "v1", paths, routeChange, longLease });
    const fakeV2 = createClaudeHarnessFakeModel({ routeId: "v2", paths, controls });
    const models: Record<1 | 2, ClaudeHarnessFakeModel> = { 1: fakeV1, 2: fakeV2 };
    let catalogRevision: 1 | 2 = 1;
    const catalog = createCatalog(() => catalogRevision, models);
    const registry = new HarnessRegistry();
    const targetGateway = new TargetModelGateway({
      grantLifetimeMs: 250,
      turnLeaseMaxMs: 180,
      maxConcurrent: 8,
    });
    const processes = new Map<string, ClaudeStreamProcess>();
    const stderr = new Map<string, string>();
    const adapters = new Set<ReturnType<typeof createAdapter>>();
    const hosts = new Set<SessionHost>();
    const target: ExecutionTarget = {
      id: CLAUDE_TARGET_ID,
      kind: "local",
      platform: process.platform as ExecutionTarget["platform"],
      available: true,
    };
    const specA = sessionSpec("claude-session-a", workspaceA);
    const specB = sessionSpec("claude-session-b", workspaceB);
    let adapter = createAdapter(
      adapterRoot,
      tracedExecutable,
      targetGateway,
      processes,
      stderr,
      root,
    );
    adapters.add(adapter);
    registry.register(adapter);
    let hostA!: SessionHost;
    let hostB!: SessionHost;
    t.after(async () => {
      routeChange.release.resolve();
      longLease.release.resolve();
      for (const host of hosts) {
        try {
          await host.whenIdle();
          await host.close();
        } catch {
          /* An asserted crash leaves an execution-unknown journal row. */
        }
      }
      for (const current of adapters) await current.shutdown();
      await targetGateway.close();
      await rm(root, { recursive: true, force: true });
      // verifyLoopbackEgress already read the traces; keep only the JSON summary artifact.
      for (const file of await straceTraceFiles(traceBase)) await rm(file, { force: true });
      assert.deepEqual(await straceTraceFiles(traceBase), [], "strace traces must not accumulate");
    });

    hostA = await SessionHost.create({ root: journalRoot, spec: specA, target, catalog, registry });
    hosts.add(hostA);
    hostB = await SessionHost.create({ root: journalRoot, spec: specB, target, catalog, registry });
    hosts.add(hostB);
    assert.equal(adapter.version, PINNED_CLAUDE_CLI_VERSION);
    assert.notEqual(hostA.binding.backendSessionId, hostB.binding.backendSessionId);

    const profileA = claudeSessionProfileRoot(adapterRoot, specA);
    const profileB = claudeSessionProfileRoot(adapterRoot, specB);
    assert.notEqual(profileA, profileB);
    const capabilityA = await readFile(
      join(profileA, "claude-config", "gateway-session-capability"),
      "utf8",
    );
    const capabilityB = await readFile(
      join(profileB, "claude-config", "gateway-session-capability"),
      "utf8",
    );
    assert.notEqual(capabilityA, capabilityB, "each Host session has its own Gateway capability");
    assert.equal(
      (await stat(join(profileA, "claude-config", "gateway-session-capability"))).mode & 0o777,
      0o600,
    );
    const settingsA = await readFile(join(profileA, "claude-config", "settings.json"), "utf8");
    const helperA = await readFile(
      join(profileA, "claude-config", "zcode-api-key-helper.mjs"),
      "utf8",
    );
    assert.equal(settingsA.includes(capabilityA), false);
    assert.equal(helperA.includes(capabilityA), false);
    const childEnvironment = createClaudeChildEnvironment({
      profile: {
        root: profileA,
        home: join(profileA, "home"),
        configDir: join(profileA, "claude-config"),
        runtimeTmp: join(profileA, "runtime-tmp"),
        cwd: workspaceA,
        settingsPath: join(profileA, "claude-config", "settings.json"),
        helperPath: join(profileA, "claude-config", "zcode-api-key-helper.mjs"),
        capabilityPath: join(profileA, "claude-config", "gateway-session-capability"),
        gatewayBaseUrl: "http://127.0.0.1:1",
        modelAlias: CLAUDE_PUBLIC_MODEL_ID,
        effort: "low",
        maxOutputTokens: 32_768,
      },
      executablePath: tracedExecutable,
    });
    assert.equal(childEnvironment.ANTHROPIC_API_KEY, undefined);
    assert.equal(childEnvironment.ANTHROPIC_AUTH_TOKEN, undefined);

    try {
      await sendAndWait(hostA, "turn-a-text", "HELLO_TEXT");
    } catch (error) {
      t.diagnostic(
        `redacted Claude stderr: ${JSON.stringify(stderr.get(specA.hostSessionId) ?? "")}`,
      );
      t.diagnostic(
        `FakeModel user prompts: ${JSON.stringify(fakeV1.trace.map((entry) => entry.userText).map((text) => text.slice(-80)))}`,
      );
      throw error;
    }
    await sendAndWait(hostB, "turn-b-text", "SESSION_B_TEXT");
    assert.ok(lastAssistant(hostA, "fake-v1:HELLO_TEXT"));
    assert.ok(lastAssistant(hostB, "fake-v1:SESSION_B_TEXT"));
    assert.equal(
      [...processes.values()].filter((process) => process.isRunning).length,
      2,
      "each Host session owns an isolated structured CLI process",
    );

    const allowTurn = "turn-allow-fixed-write";
    const allowRequest = waitForInteraction(hostA, allowTurn);
    const allowFinished = waitForTurn(hostA, allowTurn);
    await acceptSend(hostA, allowTurn, "ALLOW_FIXED_WRITE");
    const allowInteraction = await Promise.race([
      allowRequest,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          const turnEvents = hostA
            .eventsSince(0)
            .filter((e) => "turnId" in e && e.turnId === allowTurn)
            .map((e) => {
              const extra =
                e.kind === "turn.finished" && "outcome" in e
                  ? `=${e.outcome}`
                  : e.kind === "session.error" && "message" in e
                    ? `:${String(e.message).slice(0, 120)}`
                    : "";
              return `${e.kind}${extra}`;
            });
          const errors = hostA
            .eventsSince(0)
            .filter(
              (e): e is Extract<AgentEvent, { kind: "session.error" }> =>
                e.kind === "session.error",
            )
            .map((e) => String(e.message).slice(0, 200));
          const prompts = fakeV1.trace.map((e) => e.userText.slice(-40));
          const lastTool = fakeV1.trace.at(-1);
          reject(
            new Error(
              `allow interaction timeout; events=${JSON.stringify(turnEvents)} errors=${JSON.stringify(errors)} prompts=${JSON.stringify(prompts)} stderr=${JSON.stringify((stderr.get(specA.hostSessionId) ?? "").slice(-500))}`,
            ),
          );
        }, 45_000),
      ),
    ]);
    await assertMissing(paths.allowedWrite);
    await resolveInteraction(hostA, allowInteraction, "allow", "resolve-allow-once");
    await allowFinished;
    await hostA.whenIdle();
    try {
      assert.equal(await readFile(paths.allowedWrite, "utf8"), "allowed");
    } catch (error) {
      const toolEvents = hostA
        .eventsSince(0)
        .filter(
          (e) =>
            e.kind.startsWith("tool.") ||
            e.kind === "interaction.resolved" ||
            e.kind === "session.error",
        );
      t.diagnostic(
        `allow-write miss: ${JSON.stringify(toolEvents.map((e) => ({ kind: e.kind, ...("outcome" in e ? { outcome: e.outcome } : {}), ...("message" in e ? { message: String(e.message).slice(0, 160) } : {}), ...("outputText" in e ? { outputText: String(e.outputText).slice(0, 160) } : {}) })))}`,
      );
      throw error;
    }
    const duplicateAllow = await hostA.dispatch(
      resolveInteractionCommand(hostA, allowInteraction, "allow", "resolve-allow-duplicate"),
    );
    assert.equal(duplicateAllow.status, "rejected", "late duplicate answers cannot win twice");

    const denyTurn = "turn-deny-fixed-write";
    const denyRequest = waitForInteraction(hostA, denyTurn);
    const denyFinished = waitForTurn(hostA, denyTurn);
    await acceptSend(hostA, denyTurn, "DENY_FIXED_WRITE");
    const denyInteraction = await Promise.race([
      denyRequest,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          const turnEvents = hostA
            .eventsSince(0)
            .filter((e) => "turnId" in e && e.turnId === denyTurn)
            .map((e) => e.kind);
          reject(
            new Error(
              `deny interaction timeout; events=${JSON.stringify(turnEvents)} prompts=${JSON.stringify(
                fakeV1.trace.map((e) => e.userText.slice(-40)),
              )}`,
            ),
          );
        }, 60_000),
      ),
    ]);
    await assertMissing(paths.deniedWrite);
    await resolveInteraction(hostA, denyInteraction, "deny", "resolve-deny-once");
    await denyFinished;
    await hostA.whenIdle();
    await assertMissing(paths.deniedWrite);
    assert.ok(
      hostA
        .eventsSince(0)
        .some(
          (event) =>
            event.kind === "tool.finished" &&
            event.turnId === denyTurn &&
            event.outcome === "error",
        ),
    );

    // Claude PreToolUse is typically serial: the second hook does not fire until the
    // first is answered. Waiting for both interactions before resolving any deadlocks.
    // Keep one subscriber so a parallel second request is not missed between resolves.
    const multiTurn = "turn-multiple-tools";
    const multiFinished = waitForTurn(hostA, multiTurn);
    const multiQueue: Extract<AgentEvent, { kind: "interaction.requested" }>[] = [];
    let multiNotify: (() => void) | undefined;
    const stopMultiWatch = hostA.subscribe((event) => {
      if (event.kind !== "interaction.requested" || event.turnId !== multiTurn) return;
      multiQueue.push(event);
      multiNotify?.();
    });
    await acceptSend(hostA, multiTurn, "RUN_TWO_TOOLS");
    await assertMissing(paths.multiWriteA);
    await assertMissing(paths.multiWriteB);
    try {
      for (let index = 0; index < 2; index += 1) {
        const started = Date.now();
        while (multiQueue.length === 0) {
          if (Date.now() - started > 60_000) {
            throw new Error(
              `multi interaction ${index} timeout; events=${JSON.stringify(
                hostA
                  .eventsSince(0)
                  .filter((e) => "turnId" in e && e.turnId === multiTurn)
                  .map((e) => e.kind),
              )}`,
            );
          }
          await new Promise<void>((resolve) => {
            multiNotify = resolve;
            if (multiQueue.length > 0) resolve();
          });
          multiNotify = undefined;
        }
        const interaction = multiQueue.shift()!;
        await resolveInteraction(hostA, interaction, "allow", `resolve-multi-${index}`);
      }
    } finally {
      stopMultiWatch();
    }
    await multiFinished;
    await hostA.whenIdle();
    assert.equal(await readFile(paths.multiWriteA, "utf8"), "alpha");
    assert.equal(await readFile(paths.multiWriteB, "utf8"), "beta");

    const routeBinding = hostA.binding.backendSessionId;
    const longTurn = "turn-long-lease-rebind";
    const longFinished = waitForTurn(hostA, longTurn);
    await acceptSend(hostA, longTurn, "LONG_LEASE_BINDING");
    await longLease.started.promise;
    catalogRevision = 2;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(
      fakeV2.trace.some((entry) => entry.userText.includes("LONG_LEASE_BINDING")),
      false,
    );
    longLease.release.resolve();
    await longFinished;
    await hostA.whenIdle();
    assert.equal(hostA.queryBindingFact(`send-${longTurn}`)?.catalogFingerprint, "catalog-v1");
    assert.equal(hostA.binding.backendSessionId, routeBinding);
    assert.equal(
      fakeV1.trace.some((entry) => entry.userText.includes("LONG_LEASE_BINDING")),
      true,
    );

    await sendAndWait(hostA, "turn-next-binding", "NEXT_BINDING_V2");
    assert.equal(
      hostA.binding.backendSessionId,
      routeBinding,
      "idle model rebind preserves the opaque Claude session ID",
    );
    assert.equal(
      hostA.queryBindingFact("send-turn-next-binding")?.catalogFingerprint,
      "catalog-v2",
    );
    // Claude may wrap Host text in content blocks / reminders; match the FakeModel-extracted userText.
    if (!fakeV2.trace.some((entry) => entry.userText.includes("NEXT_BINDING_V2"))) {
      t.diagnostic(
        `next-binding traces v1=${JSON.stringify(fakeV1.trace.map((e) => e.userText.slice(-60)))} v2=${JSON.stringify(fakeV2.trace.map((e) => e.userText.slice(-60)))}`,
      );
    }
    assert.ok(
      fakeV2.trace.some((entry) => entry.userText.includes("NEXT_BINDING_V2")),
      "idle rebind must route the next turn to catalog-v2 FakeModel",
    );

    const cancelTurn = "turn-cancel-before-tool";
    const cancelFinished = waitForTurn(hostA, cancelTurn);
    await acceptSend(hostA, cancelTurn, "WAIT_FOR_CANCEL");
    await controls.cancelStarted.promise;
    const cancelReceipt = await hostA.dispatch({
      type: "cancelTurn",
      commandId: "cancel-before-tool",
      hostSessionId: specA.hostSessionId,
      runtimeEpoch: hostA.binding.runtimeEpoch,
      turnId: cancelTurn,
    });
    assert.equal(cancelReceipt.status, "completed");
    await cancelFinished;
    await hostA.whenIdle();
    await controls.abortObserved.promise;
    assert.ok(
      hostA
        .eventsSince(0)
        .some(
          (event) =>
            event.kind === "turn.finished" &&
            event.turnId === cancelTurn &&
            event.outcome === "cancelled",
        ),
    );

    // Resume while the session is still healthy. Host permanently fences `send`
    // after an `execution-unknown` receipt, so AFTER_RESUME must run before the
    // SIGKILL path (see agentHostRecoveryFence.test.ts).
    const nativeSessionId = hostA.binding.backendSessionId;
    const requestsBeforeResume = fakeV2.trace.length;
    await hostA.close();
    hosts.delete(hostA);
    await hostB.close();
    hosts.delete(hostB);
    await adapter.shutdown();

    const resumedRegistry = new HarnessRegistry();
    adapter = createAdapter(adapterRoot, tracedExecutable, targetGateway, processes, stderr, root);
    adapters.add(adapter);
    resumedRegistry.register(adapter);
    hostA = await SessionHost.open({
      root: journalRoot,
      spec: specA,
      target,
      catalog,
      registry: resumedRegistry,
    });
    hosts.add(hostA);
    assert.equal(hostA.binding.backendSessionId, nativeSessionId);
    assert.equal(
      fakeV2.trace.length,
      requestsBeforeResume,
      "resume attaches native history without resending Host input",
    );
    await sendAndWait(hostA, "turn-after-resume", "AFTER_RESUME_NO_REPLAY");
    assert.equal(hostA.binding.backendSessionId, nativeSessionId);
    assert.ok(lastAssistant(hostA, "fake-v2:AFTER_RESUME_NO_REPLAY"));

    const unknownTurn = "turn-unknown-exit";
    const unknownFinished = waitForTurn(hostA, unknownTurn);
    await acceptSend(hostA, unknownTurn, "WAIT_FOR_UNKNOWN");
    await controls.unknownStarted.promise;
    const crashingProcess = processes.get(specA.hostSessionId);
    assert.ok(crashingProcess?.pid);
    process.kill(-crashingProcess.pid!, "SIGKILL");
    await crashingProcess.closed;
    await unknownFinished;
    await hostA.whenIdle();
    assert.equal(hostA.queryCommand(`send-${unknownTurn}`)?.status, "execution-unknown");
    const fenced = await hostA.dispatch({
      type: "send",
      commandId: "send-after-unknown-fenced",
      hostSessionId: specA.hostSessionId,
      turnId: "turn-after-unknown-fenced",
      text: "SHOULD_BE_FENCED",
    });
    assert.equal(fenced.status, "rejected");
    assert.equal(fenced.reasonCode, "execution-unknown");

    await hostA.close();
    hosts.delete(hostA);
    await adapter.shutdown();
    await verifyLoopbackEgress(traceBase);
    await writeFile(
      join(logRoot, `claude-2.1.263-host-integration-${randomUUID()}.json`),
      JSON.stringify(
        {
          cliVersion: PINNED_CLAUDE_CLI_VERSION,
          route: "POST /v1/messages?beta=true",
          auxiliaryRoutes: ["HEAD /api/hello"],
          control: [
            "PreToolUse allow",
            "PreToolUse deny",
            "cancel",
            "unknown exit",
            "resume without replay",
          ],
          models: "loopback FakeModel only",
          egress: "Claude process connect() calls restricted to loopback by trace assertion",
        },
        null,
        2,
      ),
    );
  },
);

function createAdapter(
  root: string,
  executablePath: string,
  targetModelGateway: TargetModelGateway,
  processes: Map<string, ClaudeStreamProcess>,
  stderr: Map<string, string>,
  tempRoot: string,
) {
  return createExperimentalRegistryClaudeHarness({
    root,
    executablePath,
    registry: fakeProviderRegistry(),
    targetModelGateway,
    turnLeaseRenewIntervalMs: 35,
    fakeModelCompatibilityEvidence: (selection) =>
      selection.providerId === PROVIDER_ID && selection.modelId === MODEL_ID
        ? {
            providerId: PROVIDER_ID,
            modelId: MODEL_ID,
            fixtureId: "claude-harness-fake-model-2.1.263",
          }
        : undefined,
    onProcess: (hostSessionId, child) => {
      processes.set(hostSessionId, child);
      child.child.stderr?.on("data", (chunk: Buffer | string) => {
        const safe = String(chunk)
          .replaceAll(tempRoot, "<temp>")
          .replace(/(Bearer\s+|x-api-key\s+|sk-ant-)[^\s"']+/gi, "$1<redacted>")
          .replace(/\b[A-Za-z0-9_-]{40,64}\b/g, "<capability>");
        stderr.set(hostSessionId, ((stderr.get(hostSessionId) ?? "") + safe).slice(-4_000));
      });
    },
  });
}

function fakeProviderRegistry(): ProviderRegistryService {
  const provider = { providerId: PROVIDER_ID, config: { api: { type: "anthropic-messages" } } };
  return {
    getProvider: () => provider,
    validateSelection: () => ({ ok: true }),
  } as unknown as ProviderRegistryService;
}

function createCatalog(revision: () => 1 | 2, models: Record<1 | 2, ClaudeHarnessFakeModel>) {
  return {
    get fingerprint() {
      return `catalog-v${revision()}`;
    },
    validateSelection: () => ({ ok: true as const }),
    capture() {
      const capturedRevision = revision();
      return {
        fingerprint: `catalog-v${capturedRevision}`,
        validateSelection: () => ({ ok: true as const }),
        bindModel: () => models[capturedRevision].model,
        isCurrent: () => revision() === capturedRevision,
      };
    },
  };
}

function sessionSpec(hostSessionId: string, worktreePath: string): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: {
      targetId: CLAUDE_TARGET_ID,
      workspaceIdentity: `identity-${hostSessionId}`,
      worktreePath,
    },
    harness: { id: "claude-code", adapterVersion: PINNED_CLAUDE_CLI_VERSION },
    modelBinding: {
      kind: "host-managed",
      selection: {
        providerId: PROVIDER_ID as never,
        modelId: MODEL_ID as never,
        options: { reasoningLevel: "low" },
      },
    },
  };
}

async function sendAndWait(host: SessionHost, turnId: string, text: string): Promise<void> {
  const finished = waitForTurn(host, turnId);
  await acceptSend(host, turnId, text);
  const event = await finished;
  assert.equal(event.outcome, "success", JSON.stringify(event));
  await host.whenIdle();
  assert.equal(host.queryCommand(`send-${turnId}`)?.status, "completed");
}

async function acceptSend(host: SessionHost, turnId: string, text: string): Promise<void> {
  const receipt = await host.dispatch({
    type: "send",
    commandId: `send-${turnId}`,
    hostSessionId: host.spec.hostSessionId,
    turnId,
    text,
  });
  assert.equal(receipt.status, "accepted", JSON.stringify(receipt));
}

async function resolveInteraction(
  host: SessionHost,
  interaction: Extract<AgentEvent, { kind: "interaction.requested" }>,
  decision: "allow" | "deny",
  commandId: string,
): Promise<void> {
  const receipt = await host.dispatch(
    resolveInteractionCommand(host, interaction, decision, commandId),
  );
  assert.equal(receipt.status, "completed", JSON.stringify(receipt));
  await host.whenEventsSettled();
}

function resolveInteractionCommand(
  host: SessionHost,
  interaction: Extract<AgentEvent, { kind: "interaction.requested" }>,
  decision: "allow" | "deny",
  commandId: string,
) {
  return {
    type: "resolveInteraction" as const,
    commandId,
    hostSessionId: host.spec.hostSessionId,
    runtimeEpoch: host.binding.runtimeEpoch,
    turnId: interaction.turnId,
    interactionId: interaction.interactionId,
    decision,
  };
}

function waitForInteraction(
  host: SessionHost,
  turnId: string,
): Promise<Extract<AgentEvent, { kind: "interaction.requested" }>> {
  return waitForEvent(
    host,
    (event): event is Extract<AgentEvent, { kind: "interaction.requested" }> =>
      event.kind === "interaction.requested" && event.turnId === turnId,
  );
}

function waitForTurn(
  host: SessionHost,
  turnId: string,
): Promise<Extract<AgentEvent, { kind: "turn.finished" }>> {
  return waitForEvent(
    host,
    (event): event is Extract<AgentEvent, { kind: "turn.finished" }> =>
      event.kind === "turn.finished" && event.turnId === turnId,
  );
}

function waitForEvent<T extends AgentEvent>(
  host: SessionHost,
  predicate: (event: AgentEvent) => event is T,
): Promise<T> {
  return new Promise((resolve) => {
    const unsubscribe = host.subscribe((event) => {
      if (!predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

function lastAssistant(host: SessionHost, text: string): boolean {
  return host
    .eventsSince(0)
    .some(
      (event) =>
        event.kind === "message.finished" && event.role === "assistant" && event.text === text,
    );
}

async function assertMissing(path: string): Promise<void> {
  await assert.rejects(() => readFile(path), { code: "ENOENT" });
}

async function createStraceWrapper(
  root: string,
  executable: string,
  traceBase: string,
): Promise<string> {
  const wrapperPath = join(root, "claude-strace-wrapper.sh");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const contents = `#!/bin/sh\nexec /usr/bin/strace -ff -qq -e trace=connect -o ${quote(traceBase)} ${quote(executable)} "$@"\n`;
  await writeFile(wrapperPath, contents, { mode: 0o700 });
  await chmod(wrapperPath, 0o700);
  return wrapperPath;
}

async function straceTraceFiles(traceBase: string): Promise<string[]> {
  const directory = join(traceBase, "..");
  const prefix = traceBase.slice(traceBase.lastIndexOf("/") + 1);
  return (await readdir(directory))
    .filter((file) => file.startsWith(`${prefix}.`))
    .map((file) => join(directory, file));
}

async function verifyLoopbackEgress(traceBase: string): Promise<void> {
  const files = await straceTraceFiles(traceBase);
  assert.ok(files.length > 0, "strace must capture Claude Code connect() calls");
  const traces = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const text = traces.join("\n");
  const ipv4 = [...text.matchAll(/sa_family=AF_INET[^}]*sin_addr=inet_addr\("([^"]+)"\)/g)].map(
    (match) => match[1]!,
  );
  const ipv6 = [
    ...text.matchAll(/sa_family=AF_INET6[^}]*sin6_addr=inet_pton\(AF_INET6, "([^"]+)"\)/g),
  ].map((match) => match[1]!);
  assert.ok(ipv4.length > 0, "the pinned runtime must connect to the loopback Gateway");
  assert.ok(
    ipv4.every((address) => address.startsWith("127.")),
    JSON.stringify(ipv4),
  );
  assert.ok(
    ipv6.every((address) => address === "::1"),
    JSON.stringify(ipv6),
  );
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
