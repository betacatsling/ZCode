/**
 * SessionHost.create() failing after its manifest is already written.
 *
 * Order inside create(): plan the binding (a stale Provider/model throws
 * ModelBindingReconfigureRequiredError here, before anything touches disk) → write the manifest
 * as "creating" → adapter.create() → manifest "running" with the confirmed binding → mount (open
 * both journals, subscribe to the adapter) → first activity sidecar write.
 *
 * Contract when that first sidecar write fails: create() rejects with the original error, the
 * mounted host is released (journal owner locks, adapter subscription), no temp file stays, and the
 * session remains what it is on disk: a confirmed "running" session that lists as activity
 * "unknown" and can be attached. The early typed refusal is unchanged.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  AgentCommand,
  AgentEvent,
  BackendBinding,
  ExecutionTarget,
  HarnessCapabilities,
  SessionSpec,
} from "@zcode/shared/agent-host";
import { HarnessRegistry, type HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import { ModelBindingReconfigureRequiredError } from "../src/agent-host/modelBindingErrors.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";

const TARGET_ID = "target-a";
const HARNESS_ID = "create-probe";
const TEST_TIMEOUT_MS = 15_000;
const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };

/** Records backend creation and live subscriptions; nothing else is exercised here. */
class CreateProbeHarness implements HarnessAdapter {
  readonly id = HARNESS_ID;
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  created = 0;
  readonly #bindings = new Map<string, BackendBinding>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();

  async probe(_target: ExecutionTarget) {
    return { support: "supported" as const };
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
    this.created += 1;
    const binding: BackendBinding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `backend-${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: `epoch-${this.created}`,
    };
    this.#bindings.set(spec.hostSessionId, binding);
    return binding;
  }
  async attach(spec: SessionSpec, binding: BackendBinding): Promise<void> {
    if (this.#bindings.get(spec.hostSessionId)?.runtimeEpoch !== binding.runtimeEpoch)
      throw new Error("stale-epoch");
  }
  async send(_command: Extract<AgentCommand, { type: "send" }>): Promise<void> {}
  async cancelTurn(_command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {}
  async resolveInteraction(
    _command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {}
  async terminate(_hostSessionId: string): Promise<void> {}
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.#listeners.get(hostSessionId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(hostSessionId, listeners);
    return () => listeners.delete(listener);
  }
  listenerCount(hostSessionId: string): number {
    return this.#listeners.get(hostSessionId)?.size ?? 0;
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

function registryWith(harness: HarnessAdapter): HarnessRegistry {
  const registry = new HarnessRegistry();
  registry.register(harness);
  return registry;
}

/** Where create() will put the session's activity sidecar (same hashed identity as the manifest). */
function sidecarPathFor(root: string, spec: SessionSpec): string {
  const identity = [
    spec.execution.targetId,
    spec.execution.workspaceIdentity,
    spec.harness.id,
    spec.hostSessionId,
  ];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return join(root, `${digest}.activity.json`);
}

/** Captures console.warn (the service logger's sink) while run() is in progress. */
async function capturingWarnings(run: (warnings: unknown[][]) => Promise<void>): Promise<void> {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    await run(warnings);
  } finally {
    console.warn = original;
  }
}

async function withTemp(prefix: string, run: (temp: string) => Promise<void>): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), prefix));
  try {
    await run(temp);
  } finally {
    await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

test(
  "create() whose first activity sidecar write fails rejects with that error, releases the host and leaves an attachable running session",
  {
    timeout: TEST_TIMEOUT_MS,
    todo: "repro: the mounted host leaks (journal owner locks, adapter subscription) when the first sidecar write fails",
  },
  async () => {
    await withTemp("zcode-create-sidecar-fail-", async (temp) => {
      const root = join(temp, "host");
      const worktree = join(temp, "worktree");
      await mkdir(worktree);
      const spec = makeSpec(worktree);
      const harness = new CreateProbeHarness();
      // A non-empty directory where the sidecar goes: the atomic rename onto it fails.
      const sidecar = sidecarPathFor(root, spec);
      await mkdir(sidecar, { recursive: true });
      await writeFile(join(sidecar, "occupied"), "");

      const error = await SessionHost.create({
        root,
        spec,
        target: target(),
        catalog,
        registry: registryWith(harness),
      }).then(
        () => assert.fail("create() should reject"),
        (failure: unknown) => failure as NodeJS.ErrnoException,
      );
      assert.equal(error.syscall, "rename", `original sidecar error, got ${String(error)}`);
      assert.equal(harness.created, 1, "the backend was created before the sidecar write");
      assert.equal(harness.listenerCount("host-a"), 0, "the adapter subscription is released");
      assert.deepEqual(
        (await readdir(root)).filter((name) => name.endsWith(".tmp")),
        [],
        "no temp file stays behind",
      );

      // On disk it is a confirmed session, never a stuck "creating" one.
      const stored = await SessionHost.listStoredSessions(root, { targetId: TARGET_ID });
      assert.deepEqual(
        stored.map((record) => [record.spec.hostSessionId, record.state]),
        [["host-a", "running"]],
      );
      assert.deepEqual(
        (await SessionHost.listStoredActivityIndex(root, TARGET_ID)).map((entry) => entry.state),
        ["unknown"],
      );

      // Journal owner locks were released: the session can be attached (and indexed) right away.
      await rm(sidecar, { recursive: true });
      const attached = await SessionHost.open({
        root,
        spec,
        target: target(),
        catalog,
        registry: registryWith(harness),
      });
      try {
        assert.equal(harness.created, 1, "attach never creates a second backend");
        assert.deepEqual(
          (await SessionHost.listStoredActivityIndex(root, TARGET_ID)).map((entry) => entry.state),
          ["idle"],
        );
      } finally {
        await attached.close();
      }
    });
  },
);

test(
  "a stale Provider/model still refuses create() with the typed error before anything is written",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withTemp("zcode-create-stale-binding-", async (temp) => {
      const root = join(temp, "host");
      const worktree = join(temp, "worktree");
      await mkdir(worktree);
      const harness = new CreateProbeHarness();
      await capturingWarnings(async (warnings) => {
        await assert.rejects(
          SessionHost.create({
            root,
            spec: makeSpec(worktree),
            target: target(),
            catalog: {
              fingerprint: "registry-v1",
              validateSelection: () => ({ ok: false as const, reason: "provider-not-found" }),
            },
            registry: registryWith(harness),
          }),
          (error: unknown) => {
            assert.ok(error instanceof ModelBindingReconfigureRequiredError, String(error));
            assert.equal(error.code, "invalid-binding");
            assert.equal(error.reason, "provider-not-found");
            return true;
          },
        );
        assert.equal(harness.created, 0, "no backend is created");
        await assert.rejects(readdir(root), { code: "ENOENT" }, "no session root or manifest");
        assert.deepEqual(warnings, [], "no create-failure cleanup ran or logged");
      });
    });
  },
);
