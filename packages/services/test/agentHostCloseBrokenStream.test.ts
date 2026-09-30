/**
 * SessionHost / AgentHostTargetService 在事件流已损坏（#eventError 已设置）时的 close() 行为。
 *
 * 事件流损坏的来源：journal 追加失败（别的 hostSessionId 的事件 → "foreign event identity"，
 * 序号跳跃 → "source event sequence gap or stale event"）。损坏后 dispatch() 拒绝所有命令，
 * 包括能结束 turn 的 cancelTurn / resolveInteraction / terminateSession，所以打开的 turn
 * 再也不会结束。
 *
 * 每个可能挂住的等待都用 settle() 限时观察，每个 test 也有 timeout，回归时快速失败而不是挂住 CI。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentEventSchema,
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import { HarnessRegistry, type HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };
const TARGET_ID = "target-a";
const HARNESS_ID = "open-turn";
/** close()/whenIdle() 必须在这个时间内落定；正常路径是毫秒级。 */
const SETTLE_MS = 1_000;
const TEST_TIMEOUT_MS = 15_000;

/**
 * send 只发 turn.started 并保持 adapter run 打开，直到 cancel / release。
 * endTurnsOnShutdown=false 模拟 shutdown 不结束进行中 run 的 adapter（例如 MockHarness 没有 shutdown）。
 */
class OpenTurnHarness implements HarnessAdapter {
  readonly id = HARNESS_ID;
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly calls = {
    send: [] as string[],
    cancelTurn: [] as string[],
    resolveInteraction: [] as string[],
    terminate: [] as string[],
    shutdown: 0,
  };
  readonly #bindings = new Map<string, BackendBinding>();
  readonly #sequences = new Map<string, number>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #openTurns = new Map<string, () => void>();
  #epochCounter = 0;

  constructor(private readonly options: { endTurnsOnShutdown?: boolean } = {}) {}

  async probe(target: ExecutionTarget) {
    return target.available
      ? { support: "supported" as const }
      : { support: "unsupported" as const, reason: "target unavailable" };
  }
  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    const yes = { support: "supported" as const };
    return {
      text: yes,
      tools: yes,
      approvals: yes,
      cancelTurn: yes,
      history: yes,
      resumeExecution: yes,
      images: yes,
      modelSwitch: yes,
    };
  }
  async hostManagedSupport(target: ExecutionTarget) {
    return this.probe(target);
  }
  async create(spec: SessionSpec): Promise<BackendBinding> {
    const binding: BackendBinding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `backend-${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: `epoch-${++this.#epochCounter}`,
    };
    this.#bindings.set(spec.hostSessionId, binding);
    return binding;
  }
  async attach(spec: SessionSpec, binding: BackendBinding): Promise<void> {
    if (this.#bindings.get(spec.hostSessionId)?.runtimeEpoch !== binding.runtimeEpoch)
      throw new Error("stale-epoch");
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    this.calls.send.push(command.commandId);
    const finished = new Promise<void>((resolve) => this.#openTurns.set(command.turnId, resolve));
    this.emit(command.hostSessionId, { kind: "turn.started", turnId: command.turnId });
    await finished;
  }
  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    this.calls.cancelTurn.push(command.commandId);
    this.emit(command.hostSessionId, {
      kind: "turn.finished",
      turnId: command.turnId,
      outcome: "cancelled",
    });
    this.#openTurns.get(command.turnId)?.();
    this.#openTurns.delete(command.turnId);
  }
  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    this.calls.resolveInteraction.push(command.commandId);
  }
  async terminate(hostSessionId: string): Promise<void> {
    this.calls.terminate.push(hostSessionId);
  }
  async shutdown(): Promise<void> {
    this.calls.shutdown += 1;
    if (this.options.endTurnsOnShutdown) this.releaseAll();
  }
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.#listeners.get(hostSessionId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(hostSessionId, listeners);
    return () => listeners.delete(listener);
  }
  listenerCount(hostSessionId: string): number {
    return this.#listeners.get(hostSessionId)?.size ?? 0;
  }
  epochOf(hostSessionId: string): string {
    const binding = this.#bindings.get(hostSessionId);
    if (!binding) throw new Error("unknown session");
    return binding.runtimeEpoch;
  }
  /** 结束所有 adapter run 而不发事件（进程退出式中断）；测试收尾用，保证不留挂起的 run。 */
  releaseAll(): void {
    for (const release of this.#openTurns.values()) release();
    this.#openTurns.clear();
  }
  emit(
    hostSessionId: string,
    payload: Record<string, unknown> & { kind: AgentEvent["kind"] },
    options: { skipSequences?: number; routedTo?: string } = {},
  ): void {
    const runtimeEpoch = this.epochOf(hostSessionId);
    const key = `${hostSessionId}\u0000${runtimeEpoch}`;
    const sequence = (this.#sequences.get(key) ?? 0) + 1 + (options.skipSequences ?? 0);
    this.#sequences.set(key, sequence);
    const event = agentEventSchema.parse({
      hostSessionId,
      runtimeEpoch,
      sequence,
      eventId: `${hostSessionId}-${runtimeEpoch}-${sequence}`,
      at: sequence,
      ...payload,
    });
    for (const listener of this.#listeners.get(options.routedTo ?? hostSessionId) ?? [])
      listener(event);
  }
}

type BreakKind = "foreign event identity" | "sequence gap";
const BREAKS: readonly { kind: BreakKind; error: RegExp }[] = [
  { kind: "foreign event identity", error: /foreign event identity/ },
  { kind: "sequence gap", error: /source event sequence gap or stale event/ },
];

/** 让 hostSessionId 的事件流损坏：adapter 路由错误把别的会话的事件投给它，或者序号跳跃。 */
function breakStream(harness: OpenTurnHarness, hostSessionId: string, kind: BreakKind): void {
  if (kind === "foreign event identity") {
    // 同一 epoch 串号：旧代迟到事件会被丢弃，别的 hostSessionId 的事件仍然失败关闭。
    harness.create({ ...makeSpec("host-foreign", "/unused"), hostSessionId: "host-foreign" });
    harness.emit(
      "host-foreign",
      { kind: "session.status", state: "running" },
      {
        routedTo: hostSessionId,
      },
    );
    return;
  }
  harness.emit(hostSessionId, { kind: "session.status", state: "running" }, { skipSequences: 1 });
}

function target(): ExecutionTarget {
  return {
    id: TARGET_ID,
    kind: "local",
    platform: process.platform as "darwin" | "linux",
    available: true,
  };
}

function makeSpec(hostSessionId: string, worktreePath: string): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: { targetId: TARGET_ID, workspaceIdentity: "workspace-a", worktreePath },
    harness: { id: HARNESS_ID, adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  };
}

function registryWith(harness: HarnessAdapter): HarnessRegistry {
  const registry = new HarnessRegistry();
  registry.register(harness);
  return registry;
}

function makeService(root: string, harness: HarnessAdapter): AgentHostTargetService {
  return new AgentHostTargetService({
    root,
    target: target(),
    catalog,
    registry: registryWith(harness),
    authorizeWorktree: async () => true,
  });
}

function send(hostSessionId: string, id: string): AgentCommand {
  return { type: "send", commandId: `send-${id}`, hostSessionId, turnId: `turn-${id}`, text: "x" };
}

type Settled<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "pending" };

/** 限时观察一个 promise 的结局；"pending" 表示在 ms 内没有落定（即挂住）。 */
async function settle<T>(promise: Promise<T>, ms = SETTLE_MS): Promise<Settled<T>> {
  let timer: NodeJS.Timeout | undefined;
  const pending = new Promise<Settled<T>>((resolve) => {
    timer = setTimeout(() => resolve({ status: "pending" }), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        (value): Settled<T> => ({ status: "resolved", value }),
        (error: unknown): Settled<T> => ({ status: "rejected", error }),
      ),
      pending,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function rejection(result: Settled<unknown>, label: string): Error {
  assert.notEqual(result.status, "pending", `${label} hung (did not settle in ${SETTLE_MS}ms)`);
  assert.equal(result.status, "rejected", `${label} should reject`);
  const { error } = result as { status: "rejected"; error: unknown };
  assert.ok(error instanceof Error, `${label} should reject with an Error`);
  return error;
}

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  const result = await settle(promise);
  assert.notEqual(result.status, "pending", `${label} hung (did not settle in ${SETTLE_MS}ms)`);
  if (result.status === "rejected") throw result.error;
  return (result as { status: "resolved"; value: T }).value;
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function withRoot(
  prefix: string,
  run: (root: string, worktree: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  try {
    await run(root, worktree);
  } finally {
    // A leaked host (pre-fix) may still be writing its activity sidecar; retry instead of racing it.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

/** 建一个直接挂载的 SessionHost，发一条 send，并等 turn 在 Host 侧打开。 */
async function hostWithOpenTurn(root: string, worktree: string, harness: OpenTurnHarness) {
  const spec = makeSpec("host-a", worktree);
  const host = await SessionHost.create({
    root,
    spec,
    target: target(),
    catalog,
    registry: registryWith(harness),
  });
  assert.equal((await within(host.dispatch(send("host-a", "1")), "send")).status, "accepted");
  await waitFor(() => harness.calls.send.length === 1, "send to reach the harness");
  await within(host.whenEventsSettled(), "turn.started to settle");
  assert.equal(host.activityIndexEntry().activeTurnId, "turn-1");
  return { host, spec };
}

/** 损坏事件流并返回 Host 记下的那个错误（close() 的 cause 必须是它）。 */
async function breakAndCapture(
  host: SessionHost,
  harness: OpenTurnHarness,
  kind: BreakKind,
  expected: RegExp,
): Promise<Error> {
  breakStream(harness, "host-a", kind);
  const error = rejection(await settle(host.whenEventsSettled()), "whenEventsSettled");
  assert.match(error.message, expected);
  return error;
}

/** 断言 close() 以带类型的错误拒绝，且 cause 是原始事件流错误。 */
function assertTypedCloseError(result: Settled<void>, cause: Error): void {
  const error = rejection(result, "close()") as Error & { code?: unknown };
  assert.equal(error.code, "backend-failure");
  assert.match(error.message, /event stream is no longer reliable/);
  // 保留原始错误文本，已有按原始信息匹配的调用方（例如 open() 失败路径）不受影响。
  assert.ok(error.message.includes(cause.message), error.message);
  assert.equal(error.cause, cause);
}

const REPRO_TODO =
  "BUG sessionHost.ts whenIdle()/close(): once #eventError is set every command that could end " +
  "the open turn is refused by dispatch(), so the adapter run tracked in #active never settles. " +
  "SessionHost.close() refuses with 'active turn' forever, whenIdle() awaits Promise.all(#active) " +
  "forever, and AgentHostTargetService.close() (#finishClose: whenIdle() then close()) hangs; " +
  "with no open turn close() rethrows the raw stream error and leaks the adapter subscription, " +
  "journal locks and owner fence.";

// ---------------------------------------------------------------------------
// Guards: behaviour that holds today and must keep holding
// ---------------------------------------------------------------------------

test(
  "healthy stream, open turn: close() refuses promptly with 'active turn' and the host stays usable",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRoot("zcode-close-healthy-", async (root, worktree) => {
      const harness = new OpenTurnHarness();
      const { host, spec } = await hostWithOpenTurn(root, worktree, harness);
      try {
        const refused = rejection(await settle(host.close()), "close() with an active turn");
        assert.match(refused.message, /active turn/);
        assert.equal(harness.listenerCount("host-a"), 1, "a refused close keeps the subscription");
        const cancel = await within(
          host.dispatch({
            type: "cancelTurn",
            commandId: "cancel-1",
            hostSessionId: "host-a",
            runtimeEpoch: host.binding.runtimeEpoch,
            turnId: "turn-1",
          }),
          "cancel",
        );
        assert.equal(cancel.status, "completed");
        await within(host.whenIdle(), "whenIdle after cancel");
        assert.equal(host.queryCommand("send-1")?.status, "completed");
        await within(host.close(), "close after the turn settled");
        assert.equal(harness.listenerCount("host-a"), 0);
        await within(host.close(), "second close");
        // Journal locks were released: the session can be mounted again.
        const reopened = await within(
          SessionHost.open({
            root,
            spec,
            target: target(),
            catalog,
            registry: registryWith(harness),
          }),
          "reopen",
        );
        assert.equal(reopened.activityIndexEntry().activeTurnId, null);
        await within(reopened.close(), "close reopened");
      } finally {
        harness.releaseAll();
        await settle(host.close()).catch(() => undefined);
      }
    });
  },
);

test(
  "broken stream: every command that could end the open turn is refused, so the turn can never settle",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRoot("zcode-close-refused-", async (root, worktree) => {
      const harness = new OpenTurnHarness();
      const { host } = await hostWithOpenTurn(root, worktree, harness);
      try {
        await breakAndCapture(host, harness, "foreign event identity", /foreign event identity/);
        const epoch = host.binding.runtimeEpoch;
        const commands: AgentCommand[] = [
          {
            type: "cancelTurn",
            commandId: "c",
            hostSessionId: "host-a",
            runtimeEpoch: epoch,
            turnId: "turn-1",
          },
          {
            type: "resolveInteraction",
            commandId: "r",
            hostSessionId: "host-a",
            runtimeEpoch: epoch,
            turnId: "turn-1",
            interactionId: "approval-1",
            decision: "deny",
          },
          { type: "terminateSession", commandId: "t", hostSessionId: "host-a" },
        ];
        for (const command of commands) {
          const error = rejection(await settle(host.dispatch(command)), command.type);
          assert.match(error.message, /foreign event identity/);
        }
        assert.deepEqual(harness.calls.cancelTurn, []);
        assert.deepEqual(harness.calls.resolveInteraction, []);
        assert.deepEqual(harness.calls.terminate, []);
        assert.equal(host.activityIndexEntry().state, "unknown");
      } finally {
        harness.releaseAll();
        await settle(host.close()).catch(() => undefined);
      }
    });
  },
);

test(
  "target close: healthy open turn ended by adapter shutdown closes cleanly and releases the owner fence",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRoot("zcode-close-target-healthy-", async (root, worktree) => {
      const harness = new OpenTurnHarness({ endTurnsOnShutdown: true });
      const spec = makeSpec("host-a", worktree);
      const service = makeService(join(root, "host"), harness);
      await within(service.create(spec), "create");
      assert.equal(
        (await within(service.dispatch(spec, send("host-a", "1")), "send")).status,
        "accepted",
      );
      await waitFor(() => harness.calls.send.length === 1, "send to reach the harness");
      await within(service.close(), "target close");
      assert.equal(harness.calls.shutdown, 1);
      assert.equal(harness.listenerCount("host-a"), 0);
      // Owner fence and journal locks released: a new target owner can attach the session.
      const next = makeService(join(root, "host"), harness);
      try {
        await within(next.attach(spec), "attach from a new target owner");
        // Interrupted send is uncertain, never replayed.
        assert.equal((await next.queryCommand(spec, "send-1"))?.status, "execution-unknown");
        assert.equal(harness.calls.send.length, 1);
      } finally {
        await within(next.close(), "close new target owner");
      }
    });
  },
);

// ---------------------------------------------------------------------------
// Repro: close() with a broken event stream
// ---------------------------------------------------------------------------

for (const { kind, error: expected } of BREAKS) {
  test(
    `broken stream (${kind}), open turn: SessionHost.close() force-closes and rejects with a typed error`,
    { todo: REPRO_TODO, timeout: TEST_TIMEOUT_MS },
    async () => {
      await withRoot("zcode-close-broken-open-", async (root, worktree) => {
        const harness = new OpenTurnHarness();
        const { host, spec } = await hostWithOpenTurn(root, worktree, harness);
        try {
          const cause = await breakAndCapture(host, harness, kind, expected);
          assertTypedCloseError(await settle(host.close()), cause);
          assert.equal(harness.listenerCount("host-a"), 0, "adapter subscription removed");
          await within(host.close(), "second close is a no-op like after a normal close");
          assert.match(
            rejection(await settle(host.dispatch(send("host-a", "2"))), "dispatch after close")
              .message,
            /session host closed/,
          );
          // The adapter run finishing later must not write into the closed host.
          harness.releaseAll();
          await new Promise((resolve) => setTimeout(resolve, 20));
          // Journal locks released: the session can be mounted again; the send stays uncertain.
          const reopened = await within(
            SessionHost.open({
              root,
              spec,
              target: target(),
              catalog,
              registry: registryWith(harness),
            }),
            "reopen after force close",
          );
          assert.equal(reopened.queryCommand("send-1")?.status, "execution-unknown");
          assert.equal(harness.calls.send.length, 1, "accepted prompt is never replayed");
          await within(reopened.close(), "close reopened");
        } finally {
          harness.releaseAll();
          await settle(host.close()).catch(() => undefined);
        }
      });
    },
  );
}

test(
  "broken stream, open turn: whenIdle() stops waiting for a turn that can no longer settle",
  { todo: REPRO_TODO, timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRoot("zcode-close-whenidle-", async (root, worktree) => {
      const harness = new OpenTurnHarness();
      const { host } = await hostWithOpenTurn(root, worktree, harness);
      try {
        // Already waiting when the stream breaks.
        const waiting = settle(host.whenIdle());
        const cause = await breakAndCapture(host, harness, "sequence gap", /sequence gap/);
        assert.equal(rejection(await waiting, "whenIdle() waiting across the break"), cause);
        // Called after the break.
        assert.equal(rejection(await settle(host.whenIdle()), "whenIdle() after the break"), cause);
      } finally {
        harness.releaseAll();
        await settle(host.close()).catch(() => undefined);
      }
    });
  },
);

test(
  "broken stream, no open turn: close() still releases the host and rejects with a typed error",
  { todo: REPRO_TODO, timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRoot("zcode-close-broken-idle-", async (root, worktree) => {
      const harness = new OpenTurnHarness();
      const spec = makeSpec("host-a", worktree);
      const host = await SessionHost.create({
        root,
        spec,
        target: target(),
        catalog,
        registry: registryWith(harness),
      });
      try {
        const cause = await breakAndCapture(
          host,
          harness,
          "foreign event identity",
          /foreign event identity/,
        );
        assertTypedCloseError(await settle(host.close()), cause);
        assert.equal(harness.listenerCount("host-a"), 0, "adapter subscription removed");
        await within(host.close(), "second close");
        const reopened = await within(
          SessionHost.open({
            root,
            spec,
            target: target(),
            catalog,
            registry: registryWith(harness),
          }),
          "reopen after force close",
        );
        assert.equal(reopened.snapshot().seq, 0, "the foreign event was never journaled");
        await within(reopened.close(), "close reopened");
      } finally {
        await settle(host.close()).catch(() => undefined);
      }
    });
  },
);

for (const endTurnsOnShutdown of [false, true]) {
  test(
    `target close: broken stream with an open turn (shutdown ${endTurnsOnShutdown ? "ends" : "does not end"} the run) settles, tears down and releases the owner fence`,
    { todo: REPRO_TODO, timeout: TEST_TIMEOUT_MS },
    async () => {
      await withRoot("zcode-close-target-broken-", async (root, worktree) => {
        const harness = new OpenTurnHarness({ endTurnsOnShutdown });
        const spec = makeSpec("host-a", worktree);
        const service = makeService(join(root, "host"), harness);
        let closing: Promise<void> | undefined;
        try {
          await within(service.create(spec), "create");
          assert.equal(
            (await within(service.dispatch(spec, send("host-a", "1")), "send")).status,
            "accepted",
          );
          await waitFor(() => harness.calls.send.length === 1, "send to reach the harness");
          await within(service.snapshot(spec), "turn.started to settle");
          breakStream(harness, "host-a", "foreign event identity");
          const cause = rejection(await settle(service.snapshot(spec)), "snapshot after break");
          assert.match(cause.message, /foreign event identity/);

          closing = service.close();
          assertTypedCloseError(await settle(closing), cause);
          assert.equal(harness.calls.shutdown, 1);
          assert.equal(harness.listenerCount("host-a"), 0, "adapter subscription removed");
          await assert.rejects(service.dispatch(spec, send("host-a", "2")), /closing/);

          // Owner fence and journal locks released: a new target owner can attach the session.
          const next = makeService(join(root, "host"), harness);
          try {
            await within(next.attach(spec), "attach from a new target owner");
            assert.equal((await next.queryCommand(spec, "send-1"))?.status, "execution-unknown");
            assert.equal(harness.calls.send.length, 1, "accepted prompt is never replayed");
          } finally {
            await within(next.close(), "close new target owner");
          }
        } finally {
          harness.releaseAll();
          await settle(closing ?? service.close()).catch(() => undefined);
        }
      });
    },
  );
}
