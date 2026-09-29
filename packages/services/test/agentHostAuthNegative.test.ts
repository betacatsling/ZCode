/**
 * M2 Host 鉴权负例（docs/PROJECT-DELIVERY-PLAN.md §4 M2 / §5 协议和安全）：
 * 未授权调用不能换取 Host 能力；目标/代际不串。
 *
 * 覆盖 services 层可验证的边界：
 * - AgentHostTargetService 的 target/worktree 准入与会话身份（targetService.ts #verify/#verifyHistory）
 * - 跨进程 owner fence 预留不可劫持、被接管的旧代不能继续写（runtime/ownerFence.ts）
 * - runtimeEpoch 代际：旧 epoch 的命令不能作用于当前 turn（sessionHost.ts #isCurrentTurn），
 *   旧 epoch 的事件不会进入新 epoch 的 journal 或被转发（eventJournal.ts）
 *
 * 一次性 Host ticket（/api/rpc-host-capability → /ws/host）实现在 packages/server 与
 * packages/zcode-server-cli，不在 services 包内，本文件不跨包导入；见 M2 审计记录。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
import { EventJournal } from "../src/agent-host/eventJournal.js";
import { HarnessRegistry, type HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import { ownerFencePath, reserveOwnerLease } from "../src/agent-host/runtime/ownerFence.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

const catalog = { fingerprint: "registry-v1", validateSelection: () => ({ ok: true as const }) };
const TARGET_ID = "target-a";

/** 可控 harness：记录每次后端调用，send 保持 turn 打开直到 cancel，可注入任意 epoch 的事件。 */
class RecordingHarness implements HarnessAdapter {
  readonly id = "authneg";
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly calls = {
    create: [] as string[],
    attach: [] as string[],
    send: [] as string[],
    cancelTurn: [] as string[],
    resolveInteraction: [] as string[],
    terminate: [] as string[],
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
    this.calls.create.push(spec.hostSessionId);
    const binding: BackendBinding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: `backend-${spec.hostSessionId}`,
      backendVersion: this.version,
      runtimeEpoch: `epoch-${++this.#epochCounter}`,
    };
    this.#bindings.set(spec.hostSessionId, binding);
    this.#sequences.set(spec.hostSessionId, 0);
    return binding;
  }
  async attach(spec: SessionSpec, binding: BackendBinding): Promise<void> {
    this.calls.attach.push(spec.hostSessionId);
    if (this.#bindings.get(spec.hostSessionId)?.runtimeEpoch !== binding.runtimeEpoch)
      throw new Error("stale-epoch");
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    this.calls.send.push(command.commandId);
    const finished = new Promise<void>((resolve) => this.#openTurns.set(command.turnId, resolve));
    this.emit(command.hostSessionId, { kind: "turn.started", turnId: command.turnId });
    this.emit(command.hostSessionId, {
      kind: "tool.started",
      turnId: command.turnId,
      toolCallId: `tool-${command.turnId}`,
      name: "write",
    });
    this.emit(command.hostSessionId, {
      kind: "interaction.requested",
      turnId: command.turnId,
      interactionId: `approval-${command.turnId}`,
      toolCallId: `tool-${command.turnId}`,
      summary: "approve fixture tool",
    });
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
  /** 默认使用当前 binding 的 epoch；传 runtimeEpoch 可模拟旧代后端的迟到事件。 */
  emit(
    hostSessionId: string,
    payload: Record<string, unknown> & { kind: AgentEvent["kind"] },
    runtimeEpoch = this.epochOf(hostSessionId),
  ): void {
    const sequence = (this.#sequences.get(hostSessionId) ?? 0) + 1;
    this.#sequences.set(hostSessionId, sequence);
    const event = agentEventSchema.parse({
      hostSessionId,
      runtimeEpoch,
      sequence,
      eventId: `${hostSessionId}-${runtimeEpoch}-${sequence}`,
      at: sequence,
      ...payload,
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

function makeService(
  root: string,
  harness: HarnessAdapter,
  options: { authorize?: () => boolean; ownerGeneration?: number } = {},
): AgentHostTargetService {
  const registry = new HarnessRegistry();
  registry.register(harness);
  return new AgentHostTargetService({
    root: join(root, "host"),
    target: target(),
    catalog,
    registry,
    authorizeWorktree: async () => options.authorize?.() ?? true,
    ...(options.ownerGeneration === undefined ? {} : { ownerGeneration: options.ownerGeneration }),
  });
}

function makeSpec(
  hostSessionId: string,
  worktreePath: string,
  overrides: { targetId?: string; workspaceIdentity?: string } = {},
): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId,
    execution: {
      targetId: overrides.targetId ?? TARGET_ID,
      workspaceIdentity: overrides.workspaceIdentity ?? "workspace-a",
      worktreePath,
    },
    harness: { id: "authneg", adapterVersion: "1.0.0" },
    modelBinding: {
      kind: "host-managed",
      selection: { providerId: "provider-a", modelId: "model-a" },
    },
  };
}

function send(hostSessionId: string, id: string): AgentCommand {
  return { type: "send", commandId: `send-${id}`, hostSessionId, turnId: `turn-${id}`, text: "x" };
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

async function waitFor(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// (a) 未授权调用不能换取 Host 能力
// ---------------------------------------------------------------------------

test("M2 auth: revoked worktree authorization cannot attach or dispatch admitted commands on a mounted Host session", async () => {
  await withRoot("zcode-m2-auth-revoked-", async (root, worktree) => {
    const harness = new RecordingHarness();
    let authorized = true;
    const service = makeService(root, harness, { authorize: () => authorized });
    const spec = makeSpec("host-revoked", worktree);
    try {
      await service.create(spec);
      authorized = false;
      await assert.rejects(
        service.dispatch(spec, send("host-revoked", "1")),
        /unauthorized execution target or worktree/,
      );
      await assert.rejects(
        service.dispatch(spec, {
          type: "resolveInteraction",
          commandId: "allow-1",
          hostSessionId: "host-revoked",
          runtimeEpoch: harness.epochOf("host-revoked"),
          turnId: "turn-1",
          interactionId: "approval-turn-1",
          decision: "allow",
        }),
        /unauthorized execution target or worktree/,
      );
      await assert.rejects(service.attach(spec), /unauthorized execution target or worktree/);
      await assert.rejects(service.waitForIdle(spec), /unauthorized execution target or worktree/);
      await assert.rejects(
        service.create(makeSpec("host-revoked-2", worktree)),
        /unauthorized execution target or worktree/,
      );
      assert.deepEqual(harness.calls.send, []);
      assert.deepEqual(harness.calls.resolveInteraction, []);
      assert.deepEqual(harness.calls.create, ["host-revoked"]);
      assert.equal(await service.queryCommand(spec, "send-1"), undefined);
      assert.equal(await service.queryCommand(spec, "allow-1"), undefined);
    } finally {
      await service.close();
    }
  });
});

test("M2 auth: a spec for a foreign target cannot create, dispatch, or read Host history", async () => {
  await withRoot("zcode-m2-auth-foreign-target-", async (root, worktree) => {
    const harness = new RecordingHarness();
    const service = makeService(root, harness);
    const spec = makeSpec("host-target", worktree);
    const foreign = makeSpec("host-target", worktree, { targetId: "target-evil" });
    try {
      await service.create(spec);
      await assert.rejects(
        service.create(makeSpec("host-other", worktree, { targetId: "target-evil" })),
        /unauthorized execution target or worktree/,
      );
      await assert.rejects(
        service.dispatch(foreign, send("host-target", "1")),
        /unauthorized execution target or worktree/,
      );
      // 非准入命令（cancel/terminate）同样先过 target 校验。
      await assert.rejects(
        service.dispatch(foreign, {
          type: "terminateSession",
          commandId: "term-1",
          hostSessionId: "host-target",
        }),
        /unauthorized execution target or session history/,
      );
      await assert.rejects(
        service.snapshot(foreign),
        /unauthorized execution target or session history/,
      );
      await assert.rejects(
        service.eventsSince(foreign, 0),
        /unauthorized execution target or session history/,
      );
      await assert.rejects(
        service.queryCommand(foreign, "send-1"),
        /unauthorized execution target or session history/,
      );
      assert.deepEqual(harness.calls.send, []);
      assert.deepEqual(harness.calls.terminate, []);
    } finally {
      await service.close();
    }
  });
});

test("M2 auth: forged session identity cannot address another workspace's mounted Host session", async () => {
  await withRoot("zcode-m2-auth-forged-identity-", async (root, worktree) => {
    const harness = new RecordingHarness();
    const service = makeService(root, harness);
    const owner = makeSpec("host-owned", worktree);
    const forged = makeSpec("host-owned", worktree, { workspaceIdentity: "workspace-evil" });
    try {
      await service.create(owner);
      await assert.rejects(
        service.dispatch(forged, send("host-owned", "1")),
        /host session ID belongs to another workspace/,
      );
      await assert.rejects(
        service.dispatch(forged, {
          type: "terminateSession",
          commandId: "term-1",
          hostSessionId: "host-owned",
        }),
        /host session ID belongs to another workspace/,
      );
      await assert.rejects(service.attach(forged), /host session ID belongs to another workspace/);
      await assert.rejects(
        service.snapshot(forged),
        /host session ID belongs to another workspace/,
      );
      await assert.rejects(
        service.eventsSince(forged, 0),
        /host session ID belongs to another workspace/,
      );
      // 用合法 spec 包装指向别的会话的命令，或跨会话读取行，都被拒绝。
      await assert.rejects(
        service.dispatch(owner, send("host-someone-else", "2")),
        /foreign session command/,
      );
      await assert.rejects(
        service.conversationRowsRange(owner, { sessionId: "host-someone-else", limit: 10 }),
        /foreign session rows query/,
      );
      assert.deepEqual(harness.calls.send, []);
      assert.deepEqual(harness.calls.terminate, []);
    } finally {
      await service.close();
    }
  });
});

test(
  "M2 auth gap: terminateSession should require current worktree authorization",
  {
    todo:
      "GAP targetService.ts:184-190 — only send/createSession/resumeExecution/allow go through " +
      "#verify (authorizeWorktree); cancelTurn/deny/detach/terminateSession use #verifyHistory " +
      "(target + identity only). Irreversible terminateSession therefore succeeds after the " +
      "worktree authorization is revoked. Decide policy (fail-safe stop vs. admission) before fixing.",
  },
  async () => {
    await withRoot("zcode-m2-auth-gap-terminate-", async (root, worktree) => {
      const harness = new RecordingHarness();
      let authorized = true;
      const service = makeService(root, harness, { authorize: () => authorized });
      const spec = makeSpec("host-gap", worktree);
      try {
        await service.create(spec);
        authorized = false;
        await assert.rejects(
          service.dispatch(spec, {
            type: "terminateSession",
            commandId: "term-1",
            hostSessionId: "host-gap",
          }),
          /unauthorized/,
        );
        assert.deepEqual(harness.calls.terminate, []);
      } finally {
        await service.close();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// (c) owner reservation 不可劫持
// ---------------------------------------------------------------------------

test("M2 owner: a newer generation in a live Core cannot hijack an owner reservation", async () => {
  await withRoot("zcode-m2-owner-hijack-", async (root, worktree) => {
    const harness = new RecordingHarness();
    const gen1 = makeService(root, harness, { ownerGeneration: 1 });
    const gen2 = makeService(root, harness, { ownerGeneration: 2 });
    const spec = makeSpec("host-reserved", worktree);
    let gen1Closed = false;
    try {
      await gen1.create(spec);
      await assert.rejects(gen2.attach(spec), /runtime-host-live-owner/);
      await assert.rejects(gen2.create(spec), /runtime-host-live-owner/);
      assert.deepEqual(harness.calls.attach, []);
      assert.deepEqual(harness.calls.create, ["host-reserved"]);
      // gen2 从未挂载，不能 dispatch；gen1 仍是 owner。
      await assert.rejects(
        gen2.dispatch(spec, send("host-reserved", "hijack")),
        /external session is not attached/,
      );
      const fence = JSON.parse(
        await readFile(ownerFencePath(join(root, "host"), TARGET_ID, "host-reserved"), "utf8"),
      ) as { generation: number; fence: number };
      assert.deepEqual([fence.generation, fence.fence], [1, 1]);
      assert.equal(
        (
          await gen1.dispatch(spec, {
            type: "viewHistory",
            commandId: "view-1",
            hostSessionId: "host-reserved",
          })
        ).status,
        "completed",
      );

      // 正向对照：旧 owner 显式释放后，新代才能 attach。
      await gen1.close();
      gen1Closed = true;
      await gen2.attach(spec);
      assert.deepEqual(harness.calls.attach, ["host-reserved"]);
    } finally {
      if (!gen1Closed) await gen1.close();
      await gen2.close();
    }
  });
});

test("M2 owner: invalid generation, forged or corrupt fence records fail closed instead of being adopted", async () => {
  await withRoot("zcode-m2-owner-forged-", async (root, worktree) => {
    const hostRoot = join(root, "host");
    await assert.rejects(
      reserveOwnerLease({
        root: hostRoot,
        targetId: TARGET_ID,
        hostSessionId: "s-1",
        generation: 0,
        ownerToken: "t",
      }),
      /runtime-host-identity-mismatch/,
    );
    const zeroGen = makeService(root, new RecordingHarness(), { ownerGeneration: 0 });
    try {
      await assert.rejects(
        zeroGen.create(makeSpec("s-0", worktree)),
        /runtime-host-identity-mismatch/,
      );
    } finally {
      await zeroGen.close();
    }

    // 伪造：把另一个身份的记录放到本身份的 fence 路径上（pid 已死，也不能被接管）。
    const forgedPath = ownerFencePath(hostRoot, TARGET_ID, "s-forged");
    await mkdir(join(hostRoot, "owner-fences"), { recursive: true });
    const forged = {
      schemaVersion: 1,
      targetId: "target-evil",
      hostSessionId: "s-forged",
      fence: 7,
      pid: 2 ** 22 + 12345,
      generation: 9,
      ownerToken: "evil",
    };
    await writeFile(forgedPath, JSON.stringify(forged));
    await assert.rejects(
      reserveOwnerLease({
        root: hostRoot,
        targetId: TARGET_ID,
        hostSessionId: "s-forged",
        generation: 1,
        ownerToken: "t",
      }),
      /runtime-host-identity-mismatch/,
    );
    assert.deepEqual(JSON.parse(await readFile(forgedPath, "utf8")), forged);

    const corruptPath = ownerFencePath(hostRoot, TARGET_ID, "s-corrupt");
    await writeFile(corruptPath, "{not json");
    await assert.rejects(
      reserveOwnerLease({
        root: hostRoot,
        targetId: TARGET_ID,
        hostSessionId: "s-corrupt",
        generation: 1,
        ownerToken: "t",
      }),
      /runtime-host-fence-corrupt/,
    );
    assert.equal(await readFile(corruptPath, "utf8"), "{not json");
  });
});

// ---------------------------------------------------------------------------
// (d) 代际不串
// ---------------------------------------------------------------------------

test("M2 generation: a fenced-out older generation cannot dispatch, re-attach, or release the newer owner's fence", async () => {
  await withRoot("zcode-m2-gen-fenced-out-", async (root, worktree) => {
    const harness = new RecordingHarness();
    const gen1 = makeService(root, harness, { ownerGeneration: 1 });
    const spec = makeSpec("host-gen", worktree);
    await gen1.create(spec);
    const fencePath = ownerFencePath(join(root, "host"), TARGET_ID, "host-gen");
    const current = JSON.parse(await readFile(fencePath, "utf8")) as Record<string, unknown> & {
      fence: number;
    };
    // 模拟 Core 崩溃后新一代按 reserveOwnerLease 的接管规则写入 fence+1 / generation 2。
    const adopted = {
      ...current,
      fence: current.fence + 1,
      generation: 2,
      pid: process.ppid,
      ownerToken: "core-generation-2",
    };
    await writeFile(fencePath, JSON.stringify(adopted));

    await assert.rejects(
      gen1.dispatch(spec, send("host-gen", "stale")),
      /runtime-host-stale-fence/,
    );
    await assert.rejects(
      gen1.dispatch(spec, {
        type: "terminateSession",
        commandId: "term-stale",
        hostSessionId: "host-gen",
      }),
      /runtime-host-stale-fence/,
    );
    await assert.rejects(gen1.attach(spec), /runtime-host-stale-fence/);
    assert.deepEqual(harness.calls.send, []);
    assert.deepEqual(harness.calls.terminate, []);
    assert.equal(await gen1.queryCommand(spec, "send-stale"), undefined);
    // 旧代 close 时不能删掉新代的 fence 文件。
    await assert.rejects(gen1.close(), /runtime-host-stale-fence/);
    assert.deepEqual(JSON.parse(await readFile(fencePath, "utf8")), adopted);
  });
});

test("M2 generation: commands carrying a stale runtimeEpoch cannot cancel or resolve the current turn", async () => {
  await withRoot("zcode-m2-gen-stale-epoch-", async (root, worktree) => {
    const harness = new RecordingHarness();
    const service = makeService(root, harness);
    const spec = makeSpec("host-epoch", worktree);
    try {
      await service.create(spec);
      const epoch = harness.epochOf("host-epoch");
      assert.equal((await service.dispatch(spec, send("host-epoch", "1"))).status, "accepted");
      await waitFor(() => harness.calls.send.length === 1, "send to reach the harness");
      await service.snapshot(spec);
      const staleCancel = await service.dispatch(spec, {
        type: "cancelTurn",
        commandId: "cancel-stale",
        hostSessionId: "host-epoch",
        runtimeEpoch: "epoch-previous-generation",
        turnId: "turn-1",
      });
      assert.equal(staleCancel.status, "rejected");
      assert.equal(staleCancel.reasonCode, "stale-turn");
      for (const decision of ["allow", "deny"] as const) {
        const staleResolve = await service.dispatch(spec, {
          type: "resolveInteraction",
          commandId: `resolve-stale-${decision}`,
          hostSessionId: "host-epoch",
          runtimeEpoch: "epoch-previous-generation",
          turnId: "turn-1",
          interactionId: "approval-turn-1",
          decision,
        });
        assert.equal(staleResolve.status, "rejected");
        assert.equal(staleResolve.reasonCode, "stale-interaction");
      }
      assert.deepEqual(harness.calls.cancelTurn, []);
      assert.deepEqual(harness.calls.resolveInteraction, []);
      assert.equal((await service.snapshot(spec)).pendingInteractions.length, 1);

      // 正向对照：当前 epoch 的 cancel 生效。
      const cancel = await service.dispatch(spec, {
        type: "cancelTurn",
        commandId: "cancel-current",
        hostSessionId: "host-epoch",
        runtimeEpoch: epoch,
        turnId: "turn-1",
      });
      assert.equal(cancel.status, "completed");
      assert.deepEqual(harness.calls.cancelTurn, ["cancel-current"]);
      await service.waitForIdle(spec);
    } finally {
      await service.close();
    }
  });
});

test("M2 generation: late events from an older runtime epoch are not journaled or delivered to the new epoch", async () => {
  await withRoot("zcode-m2-gen-late-events-", async (root, worktree) => {
    const harness = new RecordingHarness();
    const service = makeService(root, harness);
    const spec = makeSpec("host-late", worktree);
    const delivered: AgentEvent[] = [];
    const unsubscribe = service.subscribe(({ event }) => delivered.push(event));
    try {
      await service.create(spec);
      harness.emit("host-late", { kind: "session.status", state: "running" }, "epoch-old");
      await assert.rejects(service.snapshot(spec), /foreign event identity/);
      assert.deepEqual(delivered, []);
      assert.deepEqual(await service.eventsSince(spec, 0).catch(() => []), []);
      // 失败关闭：同一 host 不再接受新命令，而不是在不可靠的事件流上继续执行。
      await assert.rejects(
        service.dispatch(spec, send("host-late", "1")),
        /foreign event identity/,
      );
      assert.deepEqual(harness.calls.send, []);
    } finally {
      unsubscribe();
      await service.close().catch(() => undefined);
    }
  });

  // Journal 层：每个 runtimeEpoch 独立文件，新 epoch 看不到、也写不进旧 epoch 的事件。
  const root = await mkdtemp(join(tmpdir(), "zcode-m2-gen-journal-"));
  const identity = {
    targetId: TARGET_ID,
    workspaceIdentity: "workspace-a",
    harnessId: "authneg",
    hostSessionId: "host-journal",
  };
  const oldEvent = agentEventSchema.parse({
    hostSessionId: "host-journal",
    runtimeEpoch: "epoch-1",
    sequence: 1,
    eventId: "old-1",
    at: 1,
    kind: "session.status",
    state: "running",
  });
  try {
    const gen1 = await EventJournal.open(root, { ...identity, runtimeEpoch: "epoch-1" });
    await gen1.append(oldEvent);
    await gen1.close();
    const gen2 = await EventJournal.open(root, { ...identity, runtimeEpoch: "epoch-2" });
    try {
      assert.deepEqual(gen2.since(0), []);
      await assert.rejects(gen2.append(oldEvent), /foreign event identity/);
      await assert.rejects(
        gen2.append(
          agentEventSchema.parse({
            ...oldEvent,
            runtimeEpoch: "epoch-2",
            hostSessionId: "host-other",
            eventId: "x-1",
          }),
        ),
        /foreign event identity/,
      );
      assert.equal(gen2.sequence, 0);
    } finally {
      await gen2.close();
    }
    const reopened = await EventJournal.open(root, { ...identity, runtimeEpoch: "epoch-1" });
    try {
      assert.deepEqual(
        reopened.since(0).map((event) => event.runtimeEpoch),
        ["epoch-1"],
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
