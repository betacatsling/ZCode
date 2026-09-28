import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";
import {
  agentEventSchema,
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type ExecutionTarget,
  type HarnessCapabilities,
  type ModelSelection,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { BindingPlan } from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../src/agent-host/harnessRegistry.js";

const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };

class BulkHarness implements HarnessAdapter {
  readonly id = "bulk";
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly #states = new Map<string, { binding: BackendBinding; sequence: number }>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();

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
      resumeExecution: yes,
      history: yes,
      images: { support: "unsupported", reason: "fixture" },
      modelSwitch: { support: "unsupported", reason: "fixture" },
    };
  }
  async hostManagedSupport(target: ExecutionTarget, _selection: ModelSelection) {
    return this.probe(target);
  }
  async harnessManagedSupport(target: ExecutionTarget, _nativeModelId?: string) {
    return this.probe(target);
  }
  async create(spec: SessionSpec, _plan: BindingPlan): Promise<BackendBinding> {
    if (this.#states.has(spec.hostSessionId)) throw new Error("duplicate-id");
    const binding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `bulk-${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    } satisfies BackendBinding;
    this.#states.set(spec.hostSessionId, { binding, sequence: 0 });
    return binding;
  }
  async attach(spec: SessionSpec, binding: BackendBinding): Promise<void> {
    const state = this.#states.get(spec.hostSessionId);
    if (!state || state.binding.runtimeEpoch !== binding.runtimeEpoch)
      throw new Error("stale-epoch");
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const state = this.#states.get(command.hostSessionId);
    if (!state) throw new Error("unknown session");
    this.#emit(command.hostSessionId, "turn.started", { turnId: command.turnId });
    for (let index = 0; index < 120; index += 1) {
      this.#emit(command.hostSessionId, "message.finished", {
        turnId: command.turnId,
        messageId: `message-${index}`,
        role: "assistant",
        text: `row-${index}`,
      });
    }
    this.#emit(command.hostSessionId, "turn.finished", {
      turnId: command.turnId,
      outcome: "success",
    });
  }
  async cancelTurn(_command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {}
  async resolveInteraction(
    _command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {}
  async terminate(hostSessionId: string): Promise<void> {
    this.#states.delete(hostSessionId);
  }
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.#listeners.get(hostSessionId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(hostSessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.#listeners.delete(hostSessionId);
    };
  }
  #emit(hostSessionId: string, kind: AgentEvent["kind"], payload: Record<string, unknown>): void {
    const state = this.#states.get(hostSessionId);
    if (!state) throw new Error("unknown session");
    const event = agentEventSchema.parse({
      hostSessionId,
      runtimeEpoch: state.binding.runtimeEpoch,
      sequence: ++state.sequence,
      eventId: randomUUID(),
      at: state.sequence,
      kind,
      ...payload,
    });
    for (const listener of this.#listeners.get(hostSessionId) ?? []) listener(event);
  }
}

async function collectRows(
  service: AgentHostTargetService,
  spec: SessionSpec,
): Promise<{ ids: number[]; pages: number[][]; finalHasMore: boolean }> {
  const ids: number[] = [];
  const pages: number[][] = [];
  let beforeRowId: number | undefined;
  let result = await service.conversationRowsRange(spec, {
    sessionId: spec.hostSessionId,
    limit: 50,
  });
  while (true) {
    const page = result.rows.map((row) => row.rowId);
    pages.push(page);
    ids.push(...page);
    if (!result.hasMore) return { ids, pages, finalHasMore: result.hasMore };
    const nextBeforeRowId = result.rows[0]?.rowId;
    assert.ok(nextBeforeRowId !== undefined && nextBeforeRowId < (beforeRowId ?? Infinity));
    beforeRowId = nextBeforeRowId;
    result = await service.conversationRowsRange(spec, {
      sessionId: spec.hostSessionId,
      beforeRowId,
      limit: 50,
    });
  }
}

test("target service admits only authorized workspaces, detaches without stopping and replays history", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-target-host-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId: "host-a",
    execution: { targetId: "target-a", workspaceIdentity: "workspace-a", worktreePath: worktree },
    harness: { id: "mock", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed" as const,
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  };
  const registry = new HarnessRegistry();
  const mock = new MockHarness();
  registry.register(mock);
  const service = new AgentHostTargetService({
    root: join(root, "host"),
    target: {
      id: "target-a",
      kind: "local",
      platform: process.platform as "darwin" | "linux",
      available: true,
    },
    catalog,
    registry,
    authorizeWorktree: async (candidate) =>
      candidate.execution.workspaceIdentity === "workspace-a" &&
      candidate.execution.worktreePath === worktree,
  });
  try {
    assert.deepEqual(await service.getAvailability(), {
      target: { id: "target-a", kind: "local", platform: process.platform, available: true },
      harnesses: ["mock"],
    });
    await assert.rejects(
      service.create({ ...spec, execution: { ...spec.execution, workspaceIdentity: "foreign" } }),
      /unauthorized/,
    );
    const created = await service.create(spec);
    assert.equal(created.agentHost?.harnessId, "mock");
    const send = {
      type: "send",
      commandId: "send-1",
      hostSessionId: "host-a",
      turnId: "turn-1",
      text: "mock text",
    } as const;
    assert.equal((await service.dispatch(spec, send)).status, "accepted");
    await mock.waitForInteraction("host-a");
    const before = await service.snapshot(spec);
    assert.equal(before.control.canStop, true);
    assert.equal(
      (
        await service.dispatch(spec, {
          type: "detach",
          commandId: "detach-1",
          hostSessionId: "host-a",
        })
      ).status,
      "completed",
    );
    assert.equal((await service.snapshot(spec)).pendingInteractions.length, 1);
    await service.dispatch(spec, {
      type: "resolveInteraction",
      commandId: "deny-1",
      hostSessionId: "host-a",
      runtimeEpoch: before.logEpoch,
      turnId: "turn-1",
      interactionId: "approval-1",
      decision: "deny",
    });
    const terminal = await service.waitForIdle(spec);
    assert.equal(
      terminal.rows.window.some((row) => row.kind === "assistantText"),
      true,
    );
    assert.equal((await service.queryCommand(spec, "send-1"))?.status, "completed");
    assert.equal(
      (
        await service.dispatch(spec, {
          type: "terminateSession",
          commandId: "term-1",
          hostSessionId: "host-a",
        })
      ).status,
      "completed",
    );
    await service.close();
    // The new process has no harness adapter or credentials. History is still
    // available and attach cannot accidentally recreate a terminated backend.
    const history = new AgentHostTargetService({
      root: join(root, "host"),
      target: {
        id: "target-a",
        kind: "local",
        platform: process.platform as "darwin" | "linux",
        available: true,
      },
      catalog,
      registry: new HarnessRegistry(),
      authorizeWorktree: async () => true,
    });
    assert.deepEqual(
      (await history.listSessions("workspace-a", worktree)).map((item) => [
        item.spec.hostSessionId,
        item.state,
      ]),
      [["host-a", "terminated"]],
    );
    assert.deepEqual(await history.listSessions("foreign", worktree), []);
    assert.equal(
      (await history.snapshot(spec)).rows.window.some((row) => row.kind === "assistantText"),
      true,
    );
    assert.ok((await history.eventsSince(spec, 0)).length > 0);
    assert.equal((await history.queryCommand(spec, "send-1"))?.status, "completed");
    await assert.rejects(history.attach(spec), /terminated/);
    await history.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rowsRange pages the complete live and cold Host history beyond the tail window", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-target-rows-range-"));
  const worktree = join(root, "worktree");
  await mkdir(worktree);
  const spec = {
    schemaVersion: 1 as const,
    hostSessionId: "bulk-history",
    execution: { targetId: "target-a", workspaceIdentity: "workspace-a", worktreePath: worktree },
    harness: { id: "bulk", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed" as const,
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  };
  const target = {
    id: "target-a",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux",
    available: true,
  };
  const registry = new HarnessRegistry();
  registry.register(new BulkHarness());
  const service = new AgentHostTargetService({
    root: join(root, "host"),
    target,
    catalog,
    registry,
    authorizeWorktree: async () => true,
  });
  try {
    await service.create(spec);
    assert.equal(
      (
        await service.dispatch(spec, {
          type: "send",
          commandId: "bulk-send",
          hostSessionId: spec.hostSessionId,
          turnId: "bulk-send",
          text: "bulk",
        })
      ).status,
      "accepted",
    );
    await service.waitForIdle(spec);
    const live = await collectRows(service, spec);
    assert.equal(live.pages.length, 3);
    assert.equal(live.finalHasMore, false);
    assert.deepEqual(
      [...live.ids].sort((left, right) => left - right),
      Array.from({ length: 121 }, (_, index) => index + 1),
    );
    assert.equal(new Set(live.ids).size, live.ids.length);

    await service.close();
    const history = new AgentHostTargetService({
      root: join(root, "host"),
      target,
      catalog,
      registry: new HarnessRegistry(),
      authorizeWorktree: async () => true,
    });
    try {
      const cold = await collectRows(history, spec);
      assert.deepEqual(cold.pages, live.pages);
      assert.deepEqual(cold.ids, live.ids);
      assert.equal(cold.finalHasMore, false);
    } finally {
      await history.close();
    }
  } finally {
    await service.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
