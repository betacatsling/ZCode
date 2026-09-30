/**
 * AgentHostTargetService.close() (#finishClose) closes EVERY mounted host even when some fail:
 * - a single failure is rethrown unchanged (typed errors such as EventStreamFailure stay
 *   matchable); several are reported together as TargetHostsCloseError (an AggregateError with
 *   per-session causes, in close order).
 * - a host whose close() refuses only because a send is still starting (reserved, not yet run or
 *   refused) is retried once after that send settles; if the send started running, the retry
 *   refuses with the usual active-turn error and that is reported like any other failure.
 * Host close failures are injected by removing a host's journal lock files (its journal close then
 * fails with ENOENT) or by breaking its event stream (force-close, EventStreamFailure).
 */
import assert from "node:assert/strict";
import fs, { readdirSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
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
import { EventStreamFailure } from "../src/agent-host/sessionHost.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

const TARGET_ID = "target-a";
const HARNESS_ID = "finish-close";
const SETTLE_MS = 1_000;
const TEST_TIMEOUT_MS = 15_000;
const ACTIVE_TURN = /^active turn: /;
const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };

/** Runs stay open until finishRun() (shutdown does not end them); events are manual. */
class CloseHarness implements HarnessAdapter {
  readonly id = HARNESS_ID;
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly sends: string[] = [];
  /** After shutdown(), send() throws synchronously (an adapter that refuses once shut down). */
  refuseSendAfterShutdown = false;
  shutdowns = 0;
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #runs = new Map<string, () => void>();
  readonly #sequences = new Map<string, number>();

  async probe() {
    return { support: "supported" as const };
  }
  async capabilities(): Promise<HarnessCapabilities> {
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
  async hostManagedSupport() {
    return { support: "supported" as const };
  }
  async create(spec: SessionSpec): Promise<BackendBinding> {
    return {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `backend-${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: "epoch-1",
    };
  }
  async attach(): Promise<void> {}
  send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    if (this.refuseSendAfterShutdown && this.shutdowns > 0) throw new Error("adapter is shut down");
    this.sends.push(command.commandId);
    return new Promise<void>((resolve) => this.#runs.set(command.commandId, resolve));
  }
  async cancelTurn(): Promise<void> {}
  async resolveInteraction(): Promise<void> {}
  async terminate(): Promise<void> {}
  async shutdown(): Promise<void> {
    this.shutdowns += 1;
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
  finishRun(hostSessionId: string, commandId: string, turnId: string): void {
    this.#emit(hostSessionId, (this.#sequences.get(hostSessionId) ?? 0) + 1, {
      kind: "turn.finished",
      turnId,
      outcome: "success",
    });
    this.#runs.get(commandId)?.();
  }
  /** Skips a sequence number: the journal refuses it and the host's event stream breaks. */
  breakStream(hostSessionId: string): void {
    this.#emit(hostSessionId, (this.#sequences.get(hostSessionId) ?? 0) + 2, {
      kind: "session.status",
      state: "running",
    });
  }
  #emit(hostSessionId: string, sequence: number, fields: Record<string, unknown>): void {
    this.#sequences.set(hostSessionId, sequence);
    const event = agentEventSchema.parse({
      hostSessionId,
      runtimeEpoch: "epoch-1",
      sequence,
      eventId: `${hostSessionId}-${sequence}`,
      at: sequence,
      ...fields,
    });
    for (const listener of this.#listeners.get(hostSessionId) ?? []) listener(event);
  }
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

function send(hostSessionId: string, id: string): Extract<AgentCommand, { type: "send" }> {
  return { type: "send", commandId: `send-${id}`, hostSessionId, turnId: `turn-${id}`, text: "x" };
}

type Settled<T> =
  | { status: "resolved"; value: T }
  | { status: "rejected"; error: unknown }
  | { status: "pending" };

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

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  const result = await settle(promise);
  assert.notEqual(result.status, "pending", `${label} hung (did not settle in ${SETTLE_MS}ms)`);
  if (result.status === "rejected") throw result.error;
  return (result as { status: "resolved"; value: T }).value;
}

function rejection(result: Settled<unknown>, label: string): unknown {
  assert.equal(result.status, "rejected", `${label}: expected a rejection, got ${result.status}`);
  return (result as { status: "rejected"; error: unknown }).error;
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function lockFiles(root: string): Set<string> {
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".lock")) found.add(path);
    }
  };
  walk(root);
  return found;
}

type Target = {
  root: string;
  harness: CloseHarness;
  service: AgentHostTargetService;
  specs: Map<string, SessionSpec>;
  /** Journal lock files of each mounted session. */
  locks: Map<string, string[]>;
};

function makeService(root: string, harness: CloseHarness): AgentHostTargetService {
  const registry = new HarnessRegistry();
  registry.register(harness);
  return new AgentHostTargetService({
    root,
    target: target(),
    catalog,
    registry,
    authorizeWorktree: async () => true,
  });
}

async function withTarget(
  hostSessionIds: string[],
  run: (context: Target) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "zcode-finish-close-"));
  const worktree = join(base, "worktree");
  await mkdir(worktree);
  const root = join(base, "host");
  const harness = new CloseHarness();
  const service = makeService(root, harness);
  const specs = new Map<string, SessionSpec>();
  const locks = new Map<string, string[]>();
  try {
    for (const id of hostSessionIds) {
      const before = lockFiles(base);
      const spec = makeSpec(id, worktree);
      await within(service.create(spec), `create ${id}`);
      specs.set(id, spec);
      locks.set(
        id,
        [...lockFiles(base)].filter((path) => !before.has(path)),
      );
      assert.equal(locks.get(id)?.length, 2, `${id} holds its command and event journal locks`);
    }
    await run({ root, harness, service, specs, locks });
  } finally {
    await settle(service.close()).catch(() => undefined);
    await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

/** Its journal close then fails with ENOENT: that host's close() rejects (not force-close). */
function breakJournalClose(context: Target, hostSessionId: string): void {
  for (const path of context.locks.get(hostSessionId) ?? []) rmSync(path);
}

/** Closed and released: no adapter subscription, and a new target owner can attach it. */
async function assertClosed(context: Target, hostSessionId: string): Promise<void> {
  assert.equal(context.harness.listenerCount(hostSessionId), 0, `${hostSessionId} unsubscribed`);
  const next = makeService(context.root, context.harness);
  try {
    await within(next.attach(context.specs.get(hostSessionId)!), `attach ${hostSessionId} again`);
  } finally {
    await within(next.close(), "close the next target owner");
  }
}

function assertEnoent(error: unknown, label: string): void {
  assert.equal((error as NodeJS.ErrnoException).code, "ENOENT", `${label}: ${String(error)}`);
}

/** Holds the next rename onto an activity sidecar under root; optionally fails it on release. */
function holdNextSidecarRename(root: string) {
  const promises = fs.promises as { rename: typeof fs.promises.rename };
  const original = promises.rename;
  let armed = true;
  let fail = false;
  let signalHeld!: () => void;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (signalHeld = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  promises.rename = async (from, to) => {
    const destination = String(to);
    if (!armed || !destination.startsWith(root) || !destination.endsWith(".activity.json"))
      return original(from, to);
    armed = false;
    signalHeld();
    await released;
    if (fail) throw Object.assign(new Error("injected sidecar rename failure"), { code: "EIO" });
    return original(from, to);
  };
  syncBuiltinESMExports();
  return {
    held,
    release: () => release(),
    failOnRelease: () => {
      fail = true;
      release();
    },
    restore: () => {
      release();
      promises.rename = original;
      syncBuiltinESMExports();
    },
  };
}

test(
  "one host failing to close: the others are still closed and its error is rethrown unchanged",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withTarget(["host-a", "host-b"], async (context) => {
      breakJournalClose(context, "host-a");
      const error = rejection(await settle(context.service.close()), "target close");
      assertEnoent(error, "the single failure is not wrapped");
      await assertClosed(context, "host-b");
    });
  },
);

test(
  "several hosts failing to close are aggregated with per-session causes; the rest still close",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withTarget(["host-a", "host-b", "host-c", "host-d"], async (context) => {
      const { harness, service } = context;
      harness.breakStream("host-a");
      breakJournalClose(context, "host-b");
      breakJournalClose(context, "host-c");
      const error = rejection(await settle(service.close()), "target close");
      assert.ok(error instanceof AggregateError, `aggregate, got ${String(error)}`);
      assert.equal(error.name, "TargetHostsCloseError");
      assert.equal((error as { code?: unknown }).code, "target-close-failed");
      const failures = (
        error as unknown as { failures: { hostSessionId: string; error: unknown }[] }
      ).failures;
      assert.deepEqual(
        failures.map((failure) => failure.hostSessionId),
        ["host-a", "host-b", "host-c"],
      );
      assert.ok(failures[0]?.error instanceof EventStreamFailure, "force-close stays typed");
      assertEnoent(failures[1]?.error, "host-b");
      assertEnoent(failures[2]?.error, "host-c");
      assert.deepEqual(
        error.errors,
        failures.map((failure) => failure.error),
      );
      assert.match(error.message, /^3 session hosts failed to close: host-a: event stream/);
      await assertClosed(context, "host-a");
      await assertClosed(context, "host-d");
    });
  },
);

test(
  "a send still starting at target close that the shut-down adapter refuses: that host is retried and closes",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withTarget(["host-a", "host-b"], async (context) => {
      const { root, harness, service, specs } = context;
      harness.refuseSendAfterShutdown = true;
      const rename = holdNextSidecarRename(root);
      try {
        const dispatching = settle(
          service.dispatch(specs.get("host-a")!, send("host-a", "1")),
          5_000,
        );
        await within(rename.held, "send admission reaching its sidecar write");
        const closing = settle(service.close(), 5_000);
        await tick(20);
        rename.release();
        assert.equal((await closing).status, "resolved", "target close settles cleanly");
        const receipt = await dispatching;
        assert.equal(receipt.status, "resolved");
        assert.equal(
          (receipt as { status: "resolved"; value: { status: string } }).value.status,
          "execution-unknown",
        );
        assert.deepEqual(harness.sends, [], "the send never ran");
      } finally {
        rename.restore();
      }
      await assertClosed(context, "host-a");
      await assertClosed(context, "host-b");
    });
  },
);

test(
  "a send still starting at target close whose admission then fails: that host is retried and closes",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withTarget(["host-a", "host-b"], async (context) => {
      const { root, harness, service, specs } = context;
      const rename = holdNextSidecarRename(root);
      try {
        const dispatching = settle(
          service.dispatch(specs.get("host-a")!, send("host-a", "1")),
          5_000,
        );
        await within(rename.held, "send admission reaching its sidecar write");
        const closing = settle(service.close(), 5_000);
        await tick(20);
        rename.failOnRelease();
        assert.equal((await closing).status, "resolved", "target close settles cleanly");
        const receipt = await dispatching;
        assert.equal(receipt.status, "resolved");
        assert.equal(
          (receipt as { status: "resolved"; value: { status: string } }).value.status,
          "rejected",
        );
        assert.deepEqual(harness.sends, [], "the send never ran");
      } finally {
        rename.restore();
      }
      await assertClosed(context, "host-a");
      await assertClosed(context, "host-b");
    });
  },
);

test(
  "a send still starting at target close that starts running: the retry refuses with active turn, the others close",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withTarget(["host-a", "host-b"], async (context) => {
      const { root, harness, service, specs } = context;
      const rename = holdNextSidecarRename(root);
      try {
        const dispatching = settle(
          service.dispatch(specs.get("host-a")!, send("host-a", "1")),
          5_000,
        );
        await within(rename.held, "send admission reaching its sidecar write");
        const closing = settle(service.close(), 5_000);
        await tick(20);
        rename.release();
        const error = rejection(await closing, "target close");
        assert.ok(!(error instanceof AggregateError), "a single failure is not wrapped");
        assert.match((error as Error).message, ACTIVE_TURN);
        assert.equal((error as { name?: unknown }).name, "SessionHostBusyError");
        assert.equal((error as { reason?: unknown }).reason, "active-turn");
        assert.equal((await dispatching).status, "resolved");
        assert.deepEqual(harness.sends, ["send-1"], "the send started running");
        await assertClosed(context, "host-b");
      } finally {
        rename.restore();
        harness.finishRun("host-a", "send-1", "turn-1");
      }
    });
  },
);
