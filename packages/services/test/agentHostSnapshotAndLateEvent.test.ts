/**
 * Ex2 在写 agentHostAuthNegative.test.ts 时报告的两个 services 可用性问题的确定性复现：
 *
 * 1. 审批请求（interaction.requested）先于 tool.started 到达时，Host 已把事件写进 journal，
 *    但 V4 投影拒绝它，snapshot()/attach()/conversationRowsRange() 从此对该会话一直失败；
 *    调用方拿不到待审批项，turn 永远不结束，看起来就是 snapshot() 挂住。
 * 2. 旧 runtimeEpoch 后端的迟到事件把当前会话的事件流判为不可靠，之后所有命令都被拒绝，
 *    连 close() 都失败。
 *
 * 每个异步等待都套了 within()，每个 test 也有 timeout，回归时快速失败而不是挂住 CI。
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
import { AgentHostTargetService } from "../src/agent-host/targetService.js";
import { projectHostConversation } from "../src/agent-ui-projection/projector.js";

const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };
const TARGET_ID = "target-a";
const STEP_MS = 2_000;
const TEST_TIMEOUT_MS = 15_000;

/**
 * 可脚本化 harness：send 只发 turn.started 并保持 turn 打开；其余事件由测试显式 emit。
 * 序号按 (hostSessionId, runtimeEpoch) 独立计数，与真实后端一致，迟到事件不会挤占当前代的序号。
 */
class ScriptedHarness implements HarnessAdapter {
  readonly id = "scripted";
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly calls = {
    send: [] as string[],
    cancelTurn: [] as string[],
    resolveInteraction: [] as string[],
  };
  readonly #bindings = new Map<string, BackendBinding>();
  readonly #sequences = new Map<string, number>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #openTurns = new Map<string, () => void>();
  #epochCounter = 0;

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
    this.finishTurn(command.hostSessionId, command.turnId, "cancelled");
  }
  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    this.calls.resolveInteraction.push(command.commandId);
    this.emit(command.hostSessionId, {
      kind: "interaction.resolved",
      turnId: command.turnId,
      interactionId: command.interactionId,
      decision: command.decision,
    });
  }
  async terminate(_hostSessionId: string): Promise<void> {}
  /** close() 先调用 shutdown；释放所有打开的 turn，保证测试收尾不会挂住。 */
  async shutdown(): Promise<void> {
    for (const release of this.#openTurns.values()) release();
    this.#openTurns.clear();
  }
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.#listeners.get(hostSessionId) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(hostSessionId, listeners);
    return () => listeners.delete(listener);
  }
  epochOf(hostSessionId: string): string {
    const binding = this.#bindings.get(hostSessionId);
    if (!binding) throw new Error("unknown session");
    return binding.runtimeEpoch;
  }
  finishTurn(
    hostSessionId: string,
    turnId: string,
    outcome: "success" | "cancelled" = "success",
  ): void {
    this.emit(hostSessionId, { kind: "turn.finished", turnId, outcome });
    this.#openTurns.get(turnId)?.();
    this.#openTurns.delete(turnId);
  }
  /** 原样投递一个事件给某会话的订阅者，用来模拟 adapter 路由错误。 */
  deliver(hostSessionId: string, event: AgentEvent): void {
    for (const listener of this.#listeners.get(hostSessionId) ?? []) listener(event);
  }
  /** 默认使用当前 binding 的 epoch；传 runtimeEpoch 可模拟旧代后端的迟到事件。 */
  emit(
    hostSessionId: string,
    payload: Record<string, unknown> & { kind: AgentEvent["kind"] },
    runtimeEpoch = this.epochOf(hostSessionId),
  ): void {
    const key = `${hostSessionId}\u0000${runtimeEpoch}`;
    const sequence = (this.#sequences.get(key) ?? 0) + 1;
    this.#sequences.set(key, sequence);
    const event = agentEventSchema.parse({
      hostSessionId,
      runtimeEpoch,
      sequence,
      eventId: `${hostSessionId}-${runtimeEpoch}-${sequence}`,
      at: sequence,
      ...payload,
    });
    this.deliver(hostSessionId, event);
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

function makeService(root: string, harness: HarnessAdapter): AgentHostTargetService {
  const registry = new HarnessRegistry();
  registry.register(harness);
  return new AgentHostTargetService({
    root: join(root, "host"),
    target: target(),
    catalog,
    registry,
    authorizeWorktree: async () => true,
  });
}

function makeSpec(hostSessionId: string, worktreePath: string): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: { targetId: TARGET_ID, workspaceIdentity: "workspace-a", worktreePath },
    harness: { id: "scripted", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  };
}

function send(hostSessionId: string, id: string): AgentCommand {
  return { type: "send", commandId: `send-${id}`, hostSessionId, turnId: `turn-${id}`, text: "x" };
}

/** 超时即失败：把“永不 resolve”变成确定的断言失败。 */
async function within<T>(promise: Promise<T>, label: string, ms = STEP_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms: ${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + STEP_MS;
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
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Bug 1: approval request without a preceding tool.started
// ---------------------------------------------------------------------------

test(
  "snapshot: an approval requested before tool.started is projected instead of poisoning the session",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRoot("zcode-snapshot-approval-first-", async (root, worktree) => {
      const harness = new ScriptedHarness();
      const service = makeService(root, harness);
      const spec = makeSpec("host-approval-first", worktree);
      try {
        await within(service.create(spec), "create");
        const epoch = harness.epochOf("host-approval-first");
        assert.equal(
          (await within(service.dispatch(spec, send("host-approval-first", "1")), "send")).status,
          "accepted",
        );
        await waitFor(() => harness.calls.send.length === 1, "send to reach the harness");
        // ACP session/request_permission 可以在 tool_call 更新之前到达（acpSessionMachine.ts:214-233）。
        harness.emit("host-approval-first", {
          kind: "interaction.requested",
          turnId: "turn-1",
          interactionId: "approval-1",
          toolCallId: "tool-1",
          summary: "Write file?",
        });

        const pending = await within(service.snapshot(spec), "snapshot with approval-first");
        assert.deepEqual(
          pending.pendingInteractions.map((item) => item.interactionId),
          ["approval-1"],
        );
        const anchor = pending.rows.window.find((row) => row.kind === "toolCall");
        assert.equal(anchor?.kind, "toolCall");
        assert.equal(anchor?.kind === "toolCall" && anchor.status, "pendingApproval");
        assert.equal(anchor?.kind === "toolCall" && anchor.toolCallId, "tool-1");
        assert.equal(pending.pendingInteractions[0]?.anchorRowId, anchor?.rowId);
        const rowsRange = await within(
          service.conversationRowsRange(spec, { sessionId: "host-approval-first", limit: 10 }),
          "rows range with approval-first",
        );
        assert.equal(rowsRange.atSeq, pending.seq);

        // 用户能看到审批项，就能放行；后续 tool.started 补全同一行，而不是报重复工具。
        const allow = await within(
          service.dispatch(spec, {
            type: "resolveInteraction",
            commandId: "allow-1",
            hostSessionId: "host-approval-first",
            runtimeEpoch: epoch,
            turnId: "turn-1",
            interactionId: "approval-1",
            decision: "allow",
          }),
          "allow",
        );
        assert.equal(allow.status, "completed");
        harness.emit("host-approval-first", {
          kind: "tool.started",
          turnId: "turn-1",
          toolCallId: "tool-1",
          name: "write",
          inputText: '{"path":"a.txt"}',
        });
        harness.emit("host-approval-first", {
          kind: "tool.finished",
          turnId: "turn-1",
          toolCallId: "tool-1",
          name: "write",
          outcome: "success",
        });
        harness.finishTurn("host-approval-first", "turn-1");
        const done = await within(service.waitForIdle(spec), "turn to settle");
        const tools = done.rows.window.filter((row) => row.kind === "toolCall");
        assert.equal(tools.length, 1);
        assert.equal(tools[0]?.kind === "toolCall" && tools[0].toolName, "write");
        assert.equal(tools[0]?.kind === "toolCall" && tools[0].status, "success");
        assert.equal(done.pendingInteractions.length, 0);
        assert.equal(done.control.phase, "completedSuccess");
        assert.equal((await service.queryCommand(spec, "send-1"))?.status, "completed");
      } finally {
        await within(service.close(), "close");
      }

      // 事件已经持久化：重新挂载同一会话也必须能投影，而不是永久打不开。
      const reopened = makeService(root, harness);
      try {
        const snapshot = await within(reopened.attach(spec), "re-attach after restart");
        assert.equal(snapshot.control.phase, "completedSuccess");
      } finally {
        await within(reopened.close(), "close reopened");
      }
    });
  },
);

test(
  "projection: approval-first tool rows are adopted by the later tool.started and keep approval outcome",
  { timeout: TEST_TIMEOUT_MS },
  () => {
    const spec = makeSpec("host-projection", "/tmp/unused");
    const epoch = "epoch-projection";
    let sequence = 0;
    const event = (payload: Record<string, unknown> & { kind: AgentEvent["kind"] }) =>
      agentEventSchema.parse({
        hostSessionId: "host-projection",
        runtimeEpoch: epoch,
        sequence: ++sequence,
        eventId: `evt-${sequence}`,
        at: sequence * 1000,
        ...payload,
      });
    const events = [
      event({ kind: "turn.started", turnId: "turn-1" }),
      event({
        kind: "interaction.requested",
        turnId: "turn-1",
        interactionId: "approval-1",
        toolCallId: "tool-1",
        summary: "Run command?",
      }),
    ];
    const pending = projectHostConversation({ spec, runtimeEpoch: epoch, events });
    assert.equal(pending.pendingInteractions.length, 1);
    const denied = projectHostConversation({
      spec,
      runtimeEpoch: epoch,
      events: [
        ...events,
        event({
          kind: "interaction.resolved",
          turnId: "turn-1",
          interactionId: "approval-1",
          decision: "deny",
        }),
        event({
          kind: "tool.started",
          turnId: "turn-1",
          toolCallId: "tool-1",
          name: "exec_command",
          inputText: "rm -rf /",
        }),
        event({ kind: "turn.finished", turnId: "turn-1", outcome: "success" }),
      ],
    });
    const rows = denied.rows.window.filter((row) => row.kind === "toolCall");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.kind === "toolCall" && rows[0].toolName, "exec_command");
    assert.equal(rows[0]?.kind === "toolCall" && rows[0].inputText, "rm -rf /");
    // 拒绝后的 tool.started 不能把行翻回 running。
    assert.equal(rows[0]?.kind === "toolCall" && rows[0].status, "cancelled");
    assert.equal(denied.pendingInteractions.length, 0);

    // 守卫仍在：不在当前 turn 的审批、重复审批 ID 依然拒绝。
    sequence = 2;
    assert.throws(
      () =>
        projectHostConversation({
          spec,
          runtimeEpoch: epoch,
          events: [
            ...events,
            event({
              kind: "interaction.requested",
              turnId: "turn-1",
              interactionId: "approval-1",
              toolCallId: "tool-2",
              summary: "again",
            }),
          ],
        }),
      /unmatched approval request/,
    );
    sequence = 1;
    assert.throws(
      () =>
        projectHostConversation({
          spec,
          runtimeEpoch: epoch,
          events: [
            events[0]!,
            event({
              kind: "interaction.requested",
              turnId: "turn-other",
              interactionId: "approval-x",
              toolCallId: "tool-x",
              summary: "wrong turn",
            }),
          ],
        }),
      /unmatched approval request/,
    );
  },
);

// ---------------------------------------------------------------------------
// Bug 2: late event from an older runtime epoch
// ---------------------------------------------------------------------------

test(
  "late event: an older runtime epoch's late event is dropped and the current session keeps working",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRoot("zcode-late-event-", async (root, worktree) => {
      const harness = new ScriptedHarness();
      const service = makeService(root, harness);
      const spec = makeSpec("host-late", worktree);
      const delivered: AgentEvent[] = [];
      const unsubscribe = service.subscribe(({ event }) => delivered.push(event));
      try {
        await within(service.create(spec), "create");
        const epoch = harness.epochOf("host-late");
        harness.emit("host-late", { kind: "session.status", state: "running" }, "epoch-old");

        const idle = await within(service.snapshot(spec), "snapshot after late event");
        assert.equal(idle.seq, 0);
        assert.deepEqual(await within(service.eventsSince(spec, 0), "eventsSince"), []);
        assert.equal(delivered.length, 0);

        assert.equal(
          (await within(service.dispatch(spec, send("host-late", "1")), "send")).status,
          "accepted",
        );
        await waitFor(() => harness.calls.send.length === 1, "send to reach the harness");
        // 轮次进行中再来一个旧代事件，也不能打断当前 turn 的控制面。
        harness.emit(
          "host-late",
          { kind: "turn.finished", turnId: "turn-1", outcome: "failed" },
          "epoch-old",
        );
        const running = await within(service.snapshot(spec), "snapshot mid-turn");
        assert.equal(running.control.canStop, true);
        const cancel = await within(
          service.dispatch(spec, {
            type: "cancelTurn",
            commandId: "cancel-1",
            hostSessionId: "host-late",
            runtimeEpoch: epoch,
            turnId: "turn-1",
          }),
          "cancel",
        );
        assert.equal(cancel.status, "completed");
        const done = await within(service.waitForIdle(spec), "turn to settle");
        assert.equal(done.control.phase, "completedInterrupted");
        assert.ok(delivered.every((event) => event.runtimeEpoch === epoch));
        assert.deepEqual(
          delivered.map((event) => event.kind),
          ["turn.started", "turn.finished"],
        );
      } finally {
        unsubscribe();
        await within(service.close(), "close");
      }
    });
  },
);

test(
  "late event guard: an event for another host session still fails closed",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    await withRoot("zcode-late-event-foreign-", async (root, worktree) => {
      const harness = new ScriptedHarness();
      const service = makeService(root, harness);
      const spec = makeSpec("host-guard", worktree);
      try {
        await within(service.create(spec), "create");
        // 订阅按 hostSessionId 建立；收到别的会话的事件说明 adapter 路由坏了，必须失败关闭。
        const foreign = agentEventSchema.parse({
          hostSessionId: "host-someone-else",
          runtimeEpoch: harness.epochOf("host-guard"),
          sequence: 1,
          eventId: "foreign-1",
          at: 1,
          kind: "session.status",
          state: "running",
        });
        harness.deliver("host-guard", foreign);
        await assert.rejects(within(service.snapshot(spec), "snapshot"), /foreign event identity/);
        await assert.rejects(
          within(service.dispatch(spec, send("host-guard", "1")), "send"),
          /foreign event identity/,
        );
        assert.deepEqual(harness.calls.send, []);
      } finally {
        await within(
          service.close().catch(() => undefined),
          "close",
        );
      }
    });
  },
);
