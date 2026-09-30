import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type test from "node:test";
import {
  agentEventSchema,
  type AgentEvent,
  type ExecutionTarget,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../../src/agent-host/harnessRegistry.js";
import type { ModelCatalogPort } from "../../src/agent-host/modelBindingPlanner.js";
import type { SessionHost } from "../../src/agent-host/sessionHost.js";
import { AgentHostTargetService } from "../../src/agent-host/targetService.js";
import { ClaudeBindingMismatchError } from "../../src/agent-adapters/claude/claudeBindingGuards.js";
import { claudeAdapterHarness } from "./claudeAdapterHarness.js";

// Claude reopen-after-close harness: fake launcher, a stub pinned CLI for planning, a mutable
// catalog fingerprint and a target Gateway that records (and can tamper) every grant it creates.

export const FINGERPRINT_B = "catalog-claude-unit-b";

async function pinnedClaudeScript(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-claude-reopen-pinned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "claude");
  await writeFile(
    path,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.263 (Claude Code)"; exit 0; fi\nexec cat >/dev/null\n',
    { mode: 0o700 },
  );
  return path;
}

export async function reopenHarness(t: test.TestContext) {
  const executablePath = await pinnedClaudeScript(t);
  const h = await claudeAdapterHarness(t, { adapter: { executablePath } });
  const root = join(h.root, "host");
  await mkdir(root, { mode: 0o700 });
  const registry = new HarnessRegistry();
  registry.register(h.adapter);
  const target: ExecutionTarget = {
    id: h.spec.execution.targetId,
    kind: "local",
    platform: process.platform as ExecutionTarget["platform"],
    available: true,
  };
  const state = { fingerprint: h.plan.catalogFingerprint, tamper: false };
  const catalog: ModelCatalogPort = {
    get fingerprint() {
      return state.fingerprint;
    },
    validateSelection: () => ({ ok: true }),
  };
  const gateway = h.targetModelGateway.get(h.spec.execution.targetId);
  const recordingCreate = gateway.createGrant;
  /** Fingerprint of every grant the Gateway was asked for (i.e. every startClaudeSession). */
  const grantFingerprints: string[] = [];
  gateway.createGrant = (input) => {
    grantFingerprints.push(input.modelBindingFingerprint);
    const grant = recordingCreate(input);
    return state.tamper ? { ...grant, modelBindingFingerprint: "tampered-fingerprint" } : grant;
  };
  // SessionHost's adapter subscriptions, so a test can feed one an event that breaks its stream.
  const listeners: ((event: AgentEvent) => void)[] = [];
  const subscribe = h.adapter.subscribe.bind(h.adapter);
  h.adapter.subscribe = (hostSessionId, listener) => {
    listeners.push(listener);
    return subscribe(hostSessionId, listener);
  };
  const options = { root, spec: h.spec, target, catalog, registry };
  return {
    h,
    executablePath,
    root,
    registry,
    target,
    catalog,
    state,
    grantFingerprints,
    listeners,
    options,
  };
}

export type ReopenHarness = Awaited<ReturnType<typeof reopenHarness>>;

/** The binding the session was created with. */
export function fingerprintA(r: ReopenHarness): string {
  return r.h.plan.catalogFingerprint;
}

/** Changes the captured binding (new catalog fingerprint) and makes the Gateway tamper grants. */
export function mismatchBindingB(r: ReopenHarness): void {
  r.state.fingerprint = FINGERPRINT_B;
  r.state.tamper = true;
}

export function isGrantMismatch(error: unknown): boolean {
  return (
    error instanceof ClaudeBindingMismatchError &&
    error.code === "invalid-binding" &&
    error.mismatch === "grant"
  );
}

export function sendCommand(spec: SessionSpec, turnId: string) {
  return {
    type: "send" as const,
    commandId: `send-${turnId}`,
    hostSessionId: spec.hostSessionId,
    turnId,
    text: `run ${turnId}`,
  };
}

/** Feeds the host's adapter subscription a foreign event: its stream breaks on the next journal. */
export function breakHostStream(r: ReopenHarness, host: SessionHost): void {
  r.listeners.at(-1)!(
    agentEventSchema.parse({
      hostSessionId: "claude-foreign-session",
      runtimeEpoch: host.binding.runtimeEpoch,
      sequence: 1_000,
      eventId: "claude-foreign-1000",
      at: 1_000,
      kind: "session.status",
      state: "running",
    }),
  );
}

/** Occupies the first activity sidecar path with a non-empty directory: its atomic rename fails. */
export async function occupySidecar(r: ReopenHarness): Promise<() => Promise<void>> {
  const spec = r.h.spec;
  const identity = [
    spec.execution.targetId,
    spec.execution.workspaceIdentity,
    spec.harness.id,
    spec.hostSessionId,
  ];
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  const sidecar = join(r.root, `${digest}.activity.json`);
  await mkdir(sidecar, { recursive: true });
  await writeFile(join(sidecar, "occupied"), "");
  return () => rm(sidecar, { recursive: true });
}

/** Runs with a TargetService closed before the fixture's t.after hooks remove the root. */
export async function withTargetService(
  r: ReopenHarness,
  run: (service: AgentHostTargetService) => Promise<void>,
): Promise<void> {
  const service = new AgentHostTargetService({
    root: r.root,
    target: r.target,
    catalog: r.catalog,
    registry: r.registry,
    authorizeWorktree: async () => true,
  });
  try {
    await run(service);
  } finally {
    await service.close();
  }
}
