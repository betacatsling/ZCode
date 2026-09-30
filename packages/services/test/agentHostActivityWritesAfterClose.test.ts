/**
 * No activity sidecar write may land after close() settled, and none may overwrite what close()
 * itself persisted (force-close "unknown"): same rule as turn settlements (#settleTurn) and send
 * reservation releases (#353). This file pins the remaining SessionHost sidecar writers:
 * - send admission (reserves "starting" before the accepted send is recorded): an admission that
 *   finishes after close() began must not write or accept; one already writing is awaited by
 *   close() before its force-close write.
 * - accepted send whose adapter.send threw synchronously (records execution-unknown, then writes).
 * - event delivery: an event the adapter delivered before close() unsubscribed is journaled and
 *   its sidecar write lands before close() settles, never after.
 * Sidecar renames are held (fs.promises.rename patch, as in agentHostCloseBrokenStream) so every
 * race is deterministic.
 */
import assert from "node:assert/strict";
import fs, { readFileSync, readdirSync, statSync } from "node:fs";
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
import { EventStreamFailure, SessionHost } from "../src/agent-host/sessionHost.js";

const TARGET_ID = "target-a";
const HARNESS_ID = "held-admission";
const SETTLE_MS = 1_000;
const TEST_TIMEOUT_MS = 15_000;
const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };

/** Never runs a turn; prepareTurn can be held, send can throw synchronously, events are manual. */
class ScriptedHarness implements HarnessAdapter {
  readonly id = HARNESS_ID;
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly sends: string[] = [];
  throwOnSend = false;
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  #prepareHold?: { reached: () => void; released: Promise<void> };
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
  async attach(): Promise<void> {}
  async prepareTurn(): Promise<void> {
    const hold = this.#prepareHold;
    if (!hold) return;
    this.#prepareHold = undefined;
    hold.reached();
    await hold.released;
  }
  async discardPreparedTurn(): Promise<void> {}
  send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    if (this.throwOnSend) throw new Error("send exploded synchronously");
    this.sends.push(command.commandId);
    return Promise.resolve();
  }
  async cancelTurn(): Promise<void> {}
  async resolveInteraction(): Promise<void> {}
  async terminate(): Promise<void> {}
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.#listeners.get(hostSessionId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(hostSessionId, listeners);
    return () => listeners.delete(listener);
  }
  holdNextPrepare(): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.#prepareHold = { reached, released };
    return { reached: reachedPromise, release: () => release() };
  }
  /** Next in-sequence session.status event. */
  emitStatus(hostSessionId: string, state: "idle" | "running"): void {
    this.#emit(hostSessionId, this.#sequence + 1, state);
  }
  /** Skips a sequence number: the journal refuses it and the host's event stream breaks. */
  breakStream(hostSessionId: string): void {
    this.#emit(hostSessionId, this.#sequence + 2, "running");
  }
  #emit(hostSessionId: string, sequence: number, state: "idle" | "running"): void {
    this.#sequence = sequence;
    const event = agentEventSchema.parse({
      hostSessionId,
      runtimeEpoch: "epoch-1",
      sequence,
      eventId: `${hostSessionId}-${sequence}`,
      at: sequence,
      kind: "session.status",
      state,
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

function send(id: string): AgentCommand {
  return {
    type: "send",
    commandId: `send-${id}`,
    hostSessionId: "host-a",
    turnId: `turn-${id}`,
    text: "x",
  };
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

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function assertForceClosed(result: Settled<void>): void {
  assert.notEqual(result.status, "pending", "close() hung");
  assert.equal(result.status, "rejected", "force-close rejects");
  const { error } = result as { status: "rejected"; error: unknown };
  assert.ok(error instanceof EventStreamFailure, `typed close error, got ${String(error)}`);
}

/** ino:size:mtime of every file under root except the worktree; any write or rename shows up. */
function writeFingerprint(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (path !== join(root, "worktree")) walk(path);
        continue;
      }
      const metadata = statSync(path);
      files[path.slice(root.length + 1)] = `${metadata.ino}:${metadata.size}:${metadata.mtimeMs}`;
    }
  };
  walk(root);
  return files;
}

/** The raw sidecar on disk (listStoredActivityIndex maps an unmounted "busy" to "unknown"). */
function rawSidecar(root: string): {
  state: string;
  activeTurnId: string | null;
  sequence: number;
} {
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
  return JSON.parse(readFileSync(path, "utf8")) as {
    state: string;
    activeTurnId: string | null;
    sequence: number;
  };
}

type RenameGate = { held: Promise<void>; done: Promise<void>; release: () => void };

/** Holds each of the next `count` renames onto an activity sidecar under root, in order. */
function holdSidecarRenames(root: string, count: number) {
  const promises = fs.promises as { rename: typeof fs.promises.rename };
  const original = promises.rename;
  const gates: RenameGate[] = [];
  const waits: { signalHeld: () => void; released: Promise<void>; signalDone: () => void }[] = [];
  for (let index = 0; index < count; index += 1) {
    let signalHeld!: () => void;
    let release!: () => void;
    let signalDone!: () => void;
    const held = new Promise<void>((resolve) => (signalHeld = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    const done = new Promise<void>((resolve) => (signalDone = resolve));
    gates.push({ held, done, release: () => release() });
    waits.push({ signalHeld, released, signalDone });
  }
  let next = 0;
  promises.rename = async (from, to) => {
    const destination = String(to);
    const wait = waits[next];
    if (!wait || !destination.startsWith(root) || !destination.endsWith(".activity.json"))
      return original(from, to);
    next += 1;
    wait.signalHeld();
    await wait.released;
    try {
      return await original(from, to);
    } finally {
      wait.signalDone();
    }
  };
  syncBuiltinESMExports();
  return {
    gates,
    releaseAll: () => {
      for (const gate of gates) gate.release();
    },
    restore: () => {
      promises.rename = original;
      syncBuiltinESMExports();
    },
  };
}

async function withHost(
  run: (context: { root: string; host: SessionHost; harness: ScriptedHarness }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-activity-after-close-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const harness = new ScriptedHarness();
  const registry = new HarnessRegistry();
  registry.register(harness);
  try {
    const host = await SessionHost.create({
      root,
      spec: makeSpec(worktree),
      target: target(),
      catalog,
      registry,
    });
    try {
      await run({ root, host, harness });
    } finally {
      await settle(host.close()).catch(() => undefined);
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

/** close() with a fingerprint taken the moment it settles (before the test releases anything). */
function closeAndFingerprint(host: SessionHost, root: string) {
  const state: { atClose?: Record<string, string> } = {};
  const closing = settle(
    host.close().then(
      () => {
        state.atClose = writeFingerprint(root);
      },
      (error: unknown) => {
        state.atClose = writeFingerprint(root);
        throw error;
      },
    ),
    5_000,
  );
  return { closing, state };
}

function assertClosingReceipt(result: Settled<AgentCommandReceipt>): void {
  assert.equal(result.status, "resolved", "the send settles with a receipt, not a journal error");
  const { value } = result as { status: "resolved"; value: AgentCommandReceipt };
  assert.equal(value.status, "rejected", "an admission that finishes after close() is refused");
  assert.equal(value.reasonCode, "backend-failure");
  assert.match(value.message ?? "", /session host is closing/);
}

test(
  "send admission finishing after a healthy close() began writes no sidecar and is refused",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async ({ root, host, harness }) => {
      const prepare = harness.holdNextPrepare();
      const dispatching = settle(host.dispatch(send("1")), 5_000);
      await within(prepare.reached, "send reaching adapter prepareTurn");
      const before = writeFingerprint(root);
      // close() marks the host closed, then waits for the admission lane to drain.
      const closing = settle(host.close(), 5_000);
      await tick(20);
      prepare.release();
      assert.equal((await closing).status, "resolved", "healthy close() settles");
      const receipt = await dispatching;
      const after = writeFingerprint(root);
      const sidecar = Object.keys(before).find((path) => path.endsWith(".activity.json"));
      assert.ok(sidecar);
      assert.equal(after[sidecar], before[sidecar], "no sidecar write once close() began");
      assert.equal(rawSidecar(root).state, "idle");
      const listed = await SessionHost.listStoredActivityIndex(root, TARGET_ID);
      assert.equal(listed[0]?.state, "idle", "a send that never ran does not list as unknown");
      assertClosingReceipt(receipt);
      assert.deepEqual(harness.sends, [], "the send never reached the adapter");
    });
  },
);

test(
  "send admission finishing after force-close does not overwrite the force-closed sidecar",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async ({ root, host, harness }) => {
      const prepare = harness.holdNextPrepare();
      const dispatching = settle(host.dispatch(send("1")), 5_000);
      await within(prepare.reached, "send reaching adapter prepareTurn");
      harness.breakStream("host-a");
      assert.equal((await settle(host.whenEventsSettled())).status, "rejected", "stream broke");
      // Force-close persists "unknown", then waits for the admission lane to drain.
      const closing = settle(host.close(), 5_000);
      await tick(20);
      const forceClosed = rawSidecar(root);
      assert.equal(forceClosed.state, "unknown", "force-close persisted unknown");
      assert.equal(forceClosed.activeTurnId, null);
      prepare.release();
      assertForceClosed(await closing);
      const receipt = await dispatching;
      assert.deepEqual(
        rawSidecar(root),
        forceClosed,
        "the force-closed sidecar is not overwritten",
      );
      assertClosingReceipt(receipt);
      assert.deepEqual(harness.sends, [], "the send never reached the adapter");
    });
  },
);

test(
  "send admission already writing when close() force-closes lands before the force-close write",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async ({ root, host, harness }) => {
      const renames = holdSidecarRenames(root, 1);
      try {
        const dispatching = settle(host.dispatch(send("1")), 5_000);
        await within(renames.gates[0]!.held, "send admission reaching its sidecar write");
        harness.breakStream("host-a");
        assert.equal((await settle(host.whenEventsSettled())).status, "rejected", "stream broke");
        const closing = settle(host.close(), 5_000);
        // Room for close() to write its force-close sidecar ahead of the held admission write.
        await tick(50);
        renames.gates[0]!.release();
        assertForceClosed(await closing);
        assert.notEqual((await dispatching).status, "pending", "the send settled");
        assert.deepEqual(harness.sends, [], "the send never reached the adapter");
        assert.equal(rawSidecar(root).state, "unknown", "force-close is the last sidecar write");
      } finally {
        renames.releaseAll();
        renames.restore();
      }
    });
  },
);

test(
  "the execution-unknown sidecar write of a synchronously failed send lands before close() settles",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async ({ root, host, harness }) => {
      harness.throwOnSend = true;
      // Rename 0: admission ("starting"), passes; rename 1: execution-unknown, held.
      const renames = holdSidecarRenames(root, 2);
      try {
        renames.gates[0]!.release();
        const dispatching = settle(host.dispatch(send("1")), 5_000);
        await within(renames.gates[1]!.held, "failed send reaching its sidecar write");
        const { closing, state } = closeAndFingerprint(host, root);
        // Room for close() to settle while the write is still held.
        await tick(50);
        renames.gates[1]!.release();
        assert.equal((await closing).status, "resolved", "healthy close() settles");
        await within(renames.gates[1]!.done, "held sidecar rename");
        const receipt = await dispatching;
        assert.equal(receipt.status, "resolved");
        assert.equal(
          (receipt as { status: "resolved"; value: AgentCommandReceipt }).value.status,
          "execution-unknown",
        );
        await tick(20);
        assert.deepEqual(writeFingerprint(root), state.atClose, "nothing is written after close()");
        assert.equal(rawSidecar(root).state, "unknown");
      } finally {
        renames.releaseAll();
        renames.restore();
      }
    });
  },
);

test(
  "an event delivered before close() unsubscribed is journaled with its sidecar before close() settles",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withHost(async ({ root, host, harness }) => {
      // Rename 0: event A ("running"), held while close() starts; rename 1: event B ("idle").
      const renames = holdSidecarRenames(root, 2);
      try {
        harness.emitStatus("host-a", "running");
        await within(renames.gates[0]!.held, "event A reaching its sidecar write");
        const { closing, state } = closeAndFingerprint(host, root);
        await tick(20);
        // Delivered while close() is still waiting for event A: before it unsubscribes.
        harness.emitStatus("host-a", "idle");
        renames.gates[0]!.release();
        await within(renames.gates[1]!.held, "event B reaching its sidecar write");
        // Room for close() to settle while event B's write is still held.
        await tick(50);
        renames.gates[1]!.release();
        assert.equal((await closing).status, "resolved", "healthy close() settles");
        await within(renames.gates[1]!.done, "held sidecar rename");
        await tick(20);
        assert.deepEqual(writeFingerprint(root), state.atClose, "nothing is written after close()");
        const stored = rawSidecar(root);
        assert.equal(stored.state, "idle", "the sidecar matches the journaled event B");
        assert.equal(stored.sequence, 2);
      } finally {
        renames.releaseAll();
        renames.restore();
      }
    });
  },
);
