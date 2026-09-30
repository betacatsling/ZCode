/**
 * SessionHost close() racing commands (healthy event stream):
 * - a send accepted before close() marks the host closed must not start its run under closed
 *   journals (that run could only settle as execution-unknown). close() refuses like its
 *   active-turn entry guard, whether the run started while close() waited for the event queue or
 *   the send is still reserved (admission) and about to start.
 * - terminateSession racing close(): the "terminated" manifest still lands (reopen must never
 *   restart a terminated backend), the command outcome is not recorded.
 * - an accepted send whose adapter.send threw synchronously while close() began: its
 *   execution-unknown sidecar write is skipped once the host is closed.
 * Event-queue waits are forced by holding a sidecar rename (fs.promises.rename patch).
 */
import assert from "node:assert/strict";
import fs, { readFileSync, readdirSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  agentEventSchema,
  type AgentCommand,
  type AgentCommandReceipt,
  type AgentEvent,
  type BackendBinding,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import { HarnessRegistry, type HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import { SessionHost, SessionHostClosedError } from "../src/agent-host/sessionHost.js";

const TARGET_ID = "target-a";
const HARNESS_ID = "close-race";
const SETTLE_MS = 1_000;
const TEST_TIMEOUT_MS = 15_000;
const ACTIVE_TURN = /^active turn: /;
const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };

type Hold = { reached: Promise<void>; release: () => void };
type HoldSlot = { reached: () => void; released: Promise<void> };

function makeHold(): { hold: Hold; slot: HoldSlot } {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    hold: { reached: reachedPromise, release: () => release() },
    slot: { reached, released },
  };
}

/** Runs stay open until finishRun(); prepareTurn/terminate can be held; events are manual. */
class RaceHarness implements HarnessAdapter {
  readonly id = HARNESS_ID;
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly sends: string[] = [];
  readonly terminated: string[] = [];
  attaches = 0;
  /** Called inside adapter.send, right before it throws synchronously. */
  throwOnSend?: () => void;
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #runs = new Map<string, () => void>();
  #prepareHold?: HoldSlot;
  #terminateHold?: HoldSlot;
  #sequence = 0;

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
  async attach(): Promise<void> {
    this.attaches += 1;
  }
  async prepareTurn(): Promise<void> {
    const hold = this.#prepareHold;
    this.#prepareHold = undefined;
    if (!hold) return;
    hold.reached();
    await hold.released;
  }
  async discardPreparedTurn(): Promise<void> {}
  send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    if (this.throwOnSend) {
      this.throwOnSend();
      throw new Error("send exploded synchronously");
    }
    this.sends.push(command.commandId);
    return new Promise<void>((resolve) => this.#runs.set(command.commandId, resolve));
  }
  async cancelTurn(): Promise<void> {}
  async resolveInteraction(): Promise<void> {}
  async terminate(hostSessionId: string): Promise<void> {
    const hold = this.#terminateHold;
    this.#terminateHold = undefined;
    if (hold) {
      hold.reached();
      await hold.released;
    }
    this.terminated.push(hostSessionId);
  }
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.#listeners.get(hostSessionId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(hostSessionId, listeners);
    return () => listeners.delete(listener);
  }
  holdNextPrepare(): Hold {
    const { hold, slot } = makeHold();
    this.#prepareHold = slot;
    return hold;
  }
  holdNextTerminate(): Hold {
    const { hold, slot } = makeHold();
    this.#terminateHold = slot;
    return hold;
  }
  /** Reports the turn finished, then lets its adapter run return. */
  finishRun(commandId: string, turnId: string): void {
    this.#emit({ kind: "turn.finished", turnId, outcome: "success" });
    const finish = this.#runs.get(commandId);
    assert.ok(finish, `run ${commandId} started`);
    finish();
  }
  emitStatus(state: "idle" | "running"): void {
    this.#emit({ kind: "session.status", state });
  }
  #emit(fields: Record<string, unknown>): void {
    this.#sequence += 1;
    const event = agentEventSchema.parse({
      hostSessionId: "host-a",
      runtimeEpoch: "epoch-1",
      sequence: this.#sequence,
      eventId: `host-a-${this.#sequence}`,
      at: this.#sequence,
      ...fields,
    });
    for (const listener of this.#listeners.get("host-a") ?? []) listener(event);
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

function makeSpec(worktreePath: string): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId: "host-a",
    execution: { targetId: TARGET_ID, workspaceIdentity: "workspace-a", worktreePath },
    harness: { id: HARNESS_ID, adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  };
}

const send1: Extract<AgentCommand, { type: "send" }> = {
  type: "send",
  commandId: "send-1",
  hostSessionId: "host-a",
  turnId: "turn-1",
  text: "x",
};

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

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `${label} (not reached in ${SETTLE_MS}ms)`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function rejectedWith(result: Settled<unknown>, pattern: RegExp, label: string): void {
  assert.equal(result.status, "rejected", `${label}: expected a rejection, got ${result.status}`);
  const { error } = result as { status: "rejected"; error: unknown };
  assert.match(error instanceof Error ? error.message : String(error), pattern, label);
}

function sidecarText(root: string): string {
  const walk = (dir: string): string | undefined => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = walk(path);
        if (found) return found;
      } else if (entry.name.endsWith(".activity.json")) return path;
    }
    return undefined;
  };
  const path = walk(root);
  assert.ok(path, "activity sidecar exists");
  return readFileSync(path, "utf8");
}

/** Holds the next rename onto an activity sidecar under root (see agentHostCloseBrokenStream). */
function holdNextSidecarRename(root: string) {
  const promises = fs.promises as { rename: typeof fs.promises.rename };
  const original = promises.rename;
  let armed = true;
  const { hold, slot } = makeHold();
  promises.rename = async (from, to) => {
    const destination = String(to);
    if (!armed || !destination.startsWith(root) || !destination.endsWith(".activity.json"))
      return original(from, to);
    armed = false;
    slot.reached();
    await slot.released;
    return original(from, to);
  };
  syncBuiltinESMExports();
  return {
    held: hold.reached,
    release: hold.release,
    restore: () => {
      hold.release();
      promises.rename = original;
      syncBuiltinESMExports();
    },
  };
}

type Context = {
  root: string;
  spec: SessionSpec;
  host: SessionHost;
  harness: RaceHarness;
  registry: HarnessRegistry;
};

async function withHost(run: (context: Context) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-close-race-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const harness = new RaceHarness();
  const registry = new HarnessRegistry();
  registry.register(harness);
  const spec = makeSpec(worktree);
  try {
    const host = await SessionHost.create({ root, spec, target: target(), catalog, registry });
    try {
      await run({ root, spec, host, harness, registry });
    } finally {
      await settle(host.close()).catch(() => undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

/**
 * After close() refused: the send's run is live and owned by the still-open host; finishing it
 * settles the command "completed", and close() then succeeds.
 */
async function finishRunThenClose(
  context: Context,
  dispatching: Promise<Settled<AgentCommandReceipt>>,
) {
  const { root, spec, host, harness } = context;
  const dispatched = await dispatching;
  assert.equal(dispatched.status, "resolved", "the send dispatch settles with a receipt");
  const receipt = (dispatched as { status: "resolved"; value: AgentCommandReceipt }).value;
  assert.equal(receipt.status, "accepted");
  assert.deepEqual(harness.sends, ["send-1"], "the send reached the adapter");
  harness.finishRun("send-1", "turn-1");
  await within(host.whenIdle(), "run settling");
  assert.equal(host.queryCommand("send-1")?.status, "completed");
  await within(host.close(), "close() once idle");
  assert.equal(
    (await SessionHost.queryCommandHistory(root, spec, "send-1"))?.status,
    "completed",
    "the send is not left execution-unknown",
  );
}

test(
  "a send that starts its run while close() waits for the event queue makes close() refuse",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async (context) => {
      const { root, host, harness } = context;
      const rename = holdNextSidecarRename(root);
      try {
        const prepare = harness.holdNextPrepare();
        const dispatching = settle(host.dispatch(send1), 5_000);
        await within(prepare.reached, "send reaching prepareTurn");
        // An event whose sidecar write is held keeps the event queue busy.
        harness.emitStatus("running");
        await within(rename.held, "event reaching its sidecar write");
        prepare.release();
        // Accepted: dispatch now waits for the same event queue before starting the run.
        await until(() => host.queryCommand("send-1")?.status === "accepted", "send accepted");
        const closing = settle(host.close());
        await tick(20);
        rename.release();
        rejectedWith(await closing, ACTIVE_TURN, "close() with a run started under it");
        await finishRunThenClose(context, dispatching);
      } finally {
        rename.restore();
      }
    });
  },
);

test(
  "a send accepted after close() started waiting, but before it marked the host closed, makes close() refuse",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async (context) => {
      const { root, host, harness } = context;
      const rename = holdNextSidecarRename(root);
      try {
        const prepare = harness.holdNextPrepare();
        const dispatching = settle(host.dispatch(send1), 5_000);
        await within(prepare.reached, "send reaching prepareTurn");
        harness.emitStatus("running");
        await within(rename.held, "event reaching its sidecar write");
        // close() passes its entry guard (nothing reserved yet) and waits for the event queue.
        const closing = settle(host.close());
        await tick(20);
        prepare.release();
        await until(() => host.queryCommand("send-1")?.status === "accepted", "send accepted");
        rename.release();
        rejectedWith(await closing, ACTIVE_TURN, "close() with a run started under it");
        await finishRunThenClose(context, dispatching);
      } finally {
        rename.restore();
      }
    });
  },
);

test(
  "a send reserved but not yet started when close() would mark the host closed makes close() refuse",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async (context) => {
      const { root, host } = context;
      // The send's admission sidecar write ("starting") is held: reserved, not yet accepted.
      const rename = holdNextSidecarRename(root);
      try {
        const dispatching = settle(host.dispatch(send1), 5_000);
        await within(rename.held, "send admission reaching its sidecar write");
        const closing = settle(host.close());
        const refused = await closing;
        rename.release();
        rejectedWith(refused, ACTIVE_TURN, "close() with a send reserved");
        await finishRunThenClose(context, dispatching);
      } finally {
        rename.restore();
      }
    });
  },
);

test(
  "a send refused after reserving (admission sidecar write failed) does not block a later close()",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async ({ root, host, harness }) => {
      const promises = fs.promises as { rename: typeof fs.promises.rename };
      const original = promises.rename;
      let failNext = true;
      promises.rename = async (from, to) => {
        if (failNext && String(to).startsWith(root) && String(to).endsWith(".activity.json")) {
          failNext = false;
          throw Object.assign(new Error("injected sidecar rename failure"), { code: "EIO" });
        }
        return original(from, to);
      };
      syncBuiltinESMExports();
      try {
        const receipt = await within(host.dispatch(send1), "send dispatch");
        assert.equal(receipt.status, "rejected");
        assert.equal(receipt.reasonCode, "backend-failure");
        assert.deepEqual(harness.sends, [], "the refused send never reached the adapter");
      } finally {
        promises.rename = original;
        syncBuiltinESMExports();
      }
      await within(host.close(), "close() after the refused send");
    });
  },
);

test(
  "terminateSession racing close() still persists terminated; reopen never restarts the backend",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async ({ root, spec, host, harness, registry }) => {
      const terminate = harness.holdNextTerminate();
      const terminating = settle(
        host.dispatch({ type: "terminateSession", commandId: "term-1", hostSessionId: "host-a" }),
        5_000,
      );
      await within(terminate.reached, "terminate reaching the adapter");
      // No turn is active: close() does not wait for the terminate command.
      await within(host.close(), "close() while terminate is in the adapter");
      terminate.release();
      const outcome = await terminating;
      assert.equal(outcome.status, "rejected", "the terminate outcome cannot be recorded");
      const { error } = outcome as { status: "rejected"; error: unknown };
      assert.ok(error instanceof SessionHostClosedError, `typed error, got ${String(error)}`);
      assert.equal(error.code, "host-closed");
      assert.match(error.message, /^session host closed: its outcome was not recorded$/);
      assert.deepEqual(harness.terminated, ["host-a"], "the backend was terminated");
      const [stored] = await SessionHost.listStoredSessions(root, { targetId: TARGET_ID });
      assert.equal(stored?.state, "terminated", "the manifest records terminated");
      assert.equal(
        (await SessionHost.queryCommandHistory(root, spec, "term-1"))?.status,
        "execution-unknown",
        "the unrecorded terminate outcome reads as execution-unknown",
      );
      const reopened = await settle(
        SessionHost.open({ root, spec, target: target(), catalog, registry }),
      );
      rejectedWith(reopened, /terminated session is history-only/, "reopen");
      assert.equal(harness.attaches, 0, "reopen never re-attaches a terminated backend");
    });
  },
);

test(
  "a synchronously failed send skips its execution-unknown sidecar write once close() began",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async ({ root, host, harness }) => {
      let closing: Promise<Settled<void>> | undefined;
      let atClose: string | undefined;
      harness.throwOnSend = () => {
        // close() starts in the same tick, right before dispatch records execution-unknown; it
        // marks the host closed while that journal write is still in flight.
        atClose = sidecarText(root);
        closing = settle(host.close());
      };
      const receipt = await within(host.dispatch(send1), "failed send dispatch");
      assert.equal(receipt.status, "execution-unknown", "the journal write still lands");
      assert.ok(closing, "close() started inside adapter.send");
      assert.equal((await closing).status, "resolved", "healthy close() settles");
      await tick(20);
      assert.equal(sidecarText(root), atClose, "no sidecar write once the host is closed");
      const stored = JSON.parse(atClose ?? "{}") as { state?: string; activeTurnId?: string };
      assert.equal(stored.state, "busy", "the sidecar keeps the admission write");
      assert.equal(stored.activeTurnId, "turn-1");
      const listed = await SessionHost.listStoredActivityIndex(root, TARGET_ID);
      assert.equal(listed[0]?.state, "unknown", "an unmounted busy session lists as unknown");
    });
  },
);
