/**
 * A send whose admission reserved the session (sidecar "starting") but never reached the adapter
 * releases that reservation on every refusal path (#releaseSendReservation). Releasing must never
 * write the activity sidecar after close(): the closed host's last state on disk (or whatever a
 * later owner wrote since) must not be overwritten or resurrected by a stale host.
 *
 * Deterministic route to a release racing close(): the event stream breaks while the send is in
 * admission (adapter prepareTurn held), so the accepted send is refused with "event stream is no
 * longer reliable" and releases its reservation after discardPreparedTurn, which the test holds.
 * - held discard, close() force-closes meanwhile: the release comes after close() settled.
 * - release already writing (sidecar rename held) when close() force-closes: close() must wait
 *   for that write, like it waits for turn settlements, so nothing lands after close() settles.
 */
import assert from "node:assert/strict";
import fs, { readdirSync, statSync } from "node:fs";
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
import { EventStreamFailure, SessionHost } from "../src/agent-host/sessionHost.js";

const TARGET_ID = "target-a";
const HARNESS_ID = "held-admission";
const SETTLE_MS = 1_000;
const TEST_TIMEOUT_MS = 15_000;
const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };

type HeldCall = "prepareTurn" | "discardPreparedTurn";

/** Never runs a turn; admission hooks can be held, and events can be emitted out of sequence. */
class HeldAdmissionHarness implements HarnessAdapter {
  readonly id = HARNESS_ID;
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly sends: string[] = [];
  readonly #bindings = new Map<string, BackendBinding>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #holds = new Map<HeldCall, { reached: () => void; released: Promise<void> }>();
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
    const binding: BackendBinding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `backend-${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: "epoch-1",
    };
    this.#bindings.set(spec.hostSessionId, binding);
    return binding;
  }
  async attach(): Promise<void> {}
  async prepareTurn(): Promise<void> {
    await this.#held("prepareTurn");
  }
  async discardPreparedTurn(): Promise<void> {
    await this.#held("discardPreparedTurn");
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    this.sends.push(command.commandId);
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
  holdNext(call: HeldCall): { reached: Promise<void>; release: () => void } {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => (reached = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    this.#holds.set(call, { reached, released });
    return { reached: reachedPromise, release: () => release() };
  }
  async #held(call: HeldCall): Promise<void> {
    const hold = this.#holds.get(call);
    if (!hold) return;
    this.#holds.delete(call);
    hold.reached();
    await hold.released;
  }
  /** Skips a sequence number: the journal refuses it and the host's event stream breaks. */
  breakStream(hostSessionId: string): void {
    this.#sequence += 2;
    const event = agentEventSchema.parse({
      hostSessionId,
      runtimeEpoch: "epoch-1",
      sequence: this.#sequence,
      eventId: `${hostSessionId}-${this.#sequence}`,
      at: this.#sequence,
      kind: "session.status",
      state: "running",
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

/** Holds the next rename onto an activity sidecar under root (see agentHostCloseBrokenStream). */
function holdNextSidecarRename(root: string) {
  const promises = fs.promises as { rename: typeof fs.promises.rename };
  const original = promises.rename;
  let armed = true;
  let signalHeld!: () => void;
  let release!: () => void;
  let signalDone!: () => void;
  const held = new Promise<void>((resolve) => (signalHeld = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  const done = new Promise<void>((resolve) => (signalDone = resolve));
  promises.rename = async (from, to) => {
    const destination = String(to);
    if (!armed || !destination.startsWith(root) || !destination.endsWith(".activity.json"))
      return original(from, to);
    armed = false;
    signalHeld();
    await released;
    try {
      return await original(from, to);
    } finally {
      signalDone();
    }
  };
  syncBuiltinESMExports();
  return {
    held,
    done,
    release: () => release(),
    restore: () => {
      promises.rename = original;
      syncBuiltinESMExports();
    },
  };
}

async function withRoot(run: (root: string, worktree: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-release-after-close-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  try {
    await run(root, worktree);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

/**
 * Starts send-1, breaks the stream while it is in admission, and returns once the accepted send
 * is being refused (held inside discardPreparedTurn, right before its reservation release).
 */
async function sendRefusedByBrokenStream(root: string, worktree: string) {
  const harness = new HeldAdmissionHarness();
  const registry = new HarnessRegistry();
  registry.register(harness);
  const host = await SessionHost.create({
    root,
    spec: makeSpec(worktree),
    target: target(),
    catalog,
    registry,
  });
  const prepare = harness.holdNext("prepareTurn");
  const discard = harness.holdNext("discardPreparedTurn");
  const dispatching = settle(host.dispatch(send("1")), 5_000);
  await within(prepare.reached, "send reaching adapter prepareTurn");
  harness.breakStream("host-a");
  const broken = await settle(host.whenEventsSettled());
  assert.equal(broken.status, "rejected", "the event stream broke");
  prepare.release();
  await within(discard.reached, "refused send reaching discardPreparedTurn");
  return { harness, host, discard, dispatching };
}

test(
  "a send reservation released after close() settled writes no activity sidecar",
  {
    timeout: TEST_TIMEOUT_MS,
    todo: "repro: #releaseSendReservation writes the sidecar after close()",
  },
  async () => {
    await withRoot(async (root, worktree) => {
      const { harness, host, discard, dispatching } = await sendRefusedByBrokenStream(
        root,
        worktree,
      );
      try {
        assertForceClosed(await settle(host.close()));
        const atClose = writeFingerprint(root);
        discard.release();
        const refused = await dispatching;
        assert.notEqual(refused.status, "pending", "the refused send settled");
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(writeFingerprint(root), atClose, "nothing is written after close()");
        assert.deepEqual(harness.sends, [], "the refused send never reached the adapter");
      } finally {
        discard.release();
        await settle(host.close()).catch(() => undefined);
      }
    });
  },
);

test(
  "a send reservation release already writing when close() force-closes lands before close() settles",
  {
    timeout: TEST_TIMEOUT_MS,
    todo: "repro: close() does not wait for an in-flight reservation release",
  },
  async () => {
    await withRoot(async (root, worktree) => {
      const { host, discard, dispatching } = await sendRefusedByBrokenStream(root, worktree);
      const gate = holdNextSidecarRename(root);
      try {
        discard.release();
        await within(gate.held, "reservation release reaching its sidecar write");
        let atClose: Record<string, string> | undefined;
        const closing = settle(
          host.close().then(
            () => {
              atClose = writeFingerprint(root);
            },
            (error: unknown) => {
              atClose = writeFingerprint(root);
              throw error;
            },
          ),
        );
        // Room for close() to settle while the release's write is still held.
        await new Promise((resolve) => setTimeout(resolve, 50));
        gate.release();
        assertForceClosed(await closing);
        await within(gate.done, "held sidecar rename");
        assert.notEqual((await dispatching).status, "pending", "the refused send settled");
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.deepEqual(writeFingerprint(root), atClose, "nothing is written after close()");
        const listed = await SessionHost.listStoredActivityIndex(root, TARGET_ID);
        assert.equal(
          listed.find((entry) => entry.spec.hostSessionId === "host-a")?.state,
          "unknown",
        );
      } finally {
        gate.release();
        gate.restore();
        discard.release();
        await settle(host.close()).catch(() => undefined);
      }
    });
  },
);
