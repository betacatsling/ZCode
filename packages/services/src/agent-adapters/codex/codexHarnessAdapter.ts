/* eslint-disable max-lines -- Codex 单一 turn owner 保留 native ID、lease、审批与关闭顺序的同文件审计边界。 */
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  agentEventSchema,
  backendBindingV2Schema,
  writableSessionSpecV2Schema,
  type AgentCommand,
  type AgentEvent,
  type BackendBindingV2,
  type BindingPlan,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpecV2,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../../agent-host/harnessRegistry.js";
import { createCodexTransport, type CodexNativeEvent } from "./codexTransport.js";
import { createRunningCodexTurn, type RunningCodexTurn } from "./codexTurnRuntime.js";
import { probeCodexVersion } from "./codexLaunch.js";
import type { CodexTurnLeaseIssuer } from "./codexAdapterContract.js";
import { projectCodexNotification } from "./codexCanonicalProjection.js";
import { assertCodexBinding, codexSessionProfile } from "./codexBinding.js";
import {
  advanceNativeOwnership,
  createNativeOwnership,
  readNativeOwnership,
  type NativeOwnership,
} from "./codexOwnership.js";

interface Session {
  spec: SessionSpecV2;
  cwd: string;
  plan: BindingPlan;
  binding: BackendBindingV2;
  profile: string;
  threadId?: string;
  ownership: NativeOwnership;
  sequence: number;
  running?: RunningCodexTurn;
  busy: boolean;
  finishing?: Promise<void>;
  failed?: boolean;
  prepared?: {
    turnId: string;
    runtimeEpoch: string;
    plan: BindingPlan;
    token: string;
    modelAlias: string;
  };
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Pinned Codex process is replaced at each idle turn; only Host owns admitted commands. */
export class CodexHarnessAdapter implements HarnessAdapter {
  readonly id = "codex";
  readonly version = "0.156.1";
  readonly hostManagedRoute = "responses-gateway" as const;
  readonly #sessions = new Map<string, Session>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #tokens = new Set<string>();
  readonly #aliases = new Set<string>();
  constructor(
    private readonly options: {
      root: string;
      lease: CodexTurnLeaseIssuer;
      executable?: string;
      spawnProcess?: typeof spawn;
    },
  ) {}

  async probe(target: ExecutionTarget) {
    if (!target.available || target.platform !== process.platform)
      return {
        support: "unsupported" as const,
        reason: "Codex must run on an available execution target",
      };
    try {
      await mkdir(this.options.root, { recursive: true, mode: 0o700 });
      await probeCodexVersion(
        this.options.executable ?? "codex",
        this.options.spawnProcess ?? spawn,
        this.options.root,
        {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: this.options.root,
          LANG: "C.UTF-8",
        },
      );
      return { support: "supported" as const };
    } catch {
      return {
        support: "unsupported" as const,
        reason: "pinned codex-cli 0.156.1 not available on target",
      };
    }
  }
  async hostManagedSupport(target: ExecutionTarget, selection: ModelSelection) {
    if (!target.available || target.platform !== process.platform)
      return { support: "unsupported" as const, reason: "Codex target unavailable" };
    if (selection.options?.reasoningLevel !== "off")
      return {
        support: "unsupported" as const,
        reason: "Codex gateway certifies only reasoning off",
      };
    return { support: "supported" as const };
  }
  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    const yes = { support: "supported" as const };
    const no = { support: "unsupported" as const, reason: "not certified by pinned Codex adapter" };
    return {
      text: yes,
      tools: yes,
      approvals: yes,
      cancelTurn: yes,
      history: yes,
      resumeExecution: no,
      images: no,
      modelSwitch: no,
    };
  }
  async create(spec: SessionSpecV2, plan: BindingPlan): Promise<BackendBindingV2> {
    writableSessionSpecV2Schema.parse(spec);
    if (JSON.stringify(plan.requested) !== JSON.stringify(spec.modelBinding))
      throw new Error("Codex initial binding mismatch");
    assertCodexBinding(spec, plan);
    if (this.#sessions.has(spec.hostSessionId)) throw new Error("duplicate Codex session");
    const cwd = await this.#verifiedCwd(spec);
    const profile = codexSessionProfile(this.options.root, spec);
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const binding = backendBindingV2Schema.parse({
      schemaVersion: 2,
      targetId: spec.execution.targetId,
      workspaceId: spec.workspaceId,
      worktreeGeneration: spec.execution.worktreeGeneration,
      harnessId: this.id,
      hostSessionId: spec.hostSessionId,
      backendSessionId: randomUUID(),
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    });
    const ownership = await createNativeOwnership(profile, binding, spec, cwd);
    this.#sessions.set(spec.hostSessionId, {
      spec,
      cwd,
      plan,
      binding,
      profile,
      ownership,
      sequence: 0,
      busy: false,
    });
    return binding;
  }
  async attach(
    spec: SessionSpecV2,
    raw: BackendBindingV2,
    sequence: number,
    plan: BindingPlan,
  ): Promise<void> {
    writableSessionSpecV2Schema.parse(spec);
    assertCodexBinding(spec, plan);
    const binding = backendBindingV2Schema.parse(raw);
    if (
      binding.hostSessionId !== spec.hostSessionId ||
      binding.targetId !== spec.execution.targetId ||
      binding.workspaceId !== spec.workspaceId ||
      binding.worktreeGeneration !== spec.execution.worktreeGeneration ||
      binding.harnessId !== this.id ||
      binding.backendVersion !== this.version ||
      !Number.isSafeInteger(sequence) ||
      sequence < 0
    )
      throw new Error("stale Codex binding");
    const existing = this.#sessions.get(spec.hostSessionId);
    if (existing) {
      if (
        JSON.stringify(existing.spec) !== JSON.stringify(spec) ||
        existing.binding.backendSessionId !== binding.backendSessionId ||
        existing.binding.runtimeEpoch !== binding.runtimeEpoch
      )
        throw new Error("stale Codex binding");
      return;
    }
    const cwd = await this.#verifiedCwd(spec);
    const profile = codexSessionProfile(this.options.root, spec);
    const ownership = await readNativeOwnership(profile, binding, spec, cwd);
    this.#sessions.set(spec.hostSessionId, {
      spec,
      cwd,
      binding,
      plan,
      profile,
      threadId: ownership.threadId,
      ownership,
      sequence,
      busy: false,
    });
  }
  async prepareTurn(
    spec: SessionSpecV2,
    input: { turnId: string; runtimeEpoch: string; plan: BindingPlan },
  ): Promise<void> {
    const session = this.#require(spec.hostSessionId);
    if (
      JSON.stringify(session.spec) !== JSON.stringify(spec) ||
      session.binding.runtimeEpoch !== input.runtimeEpoch ||
      session.busy ||
      session.running ||
      session.prepared ||
      session.failed ||
      !input.turnId
    )
      throw new Error("stale or busy Codex turn");
    assertCodexBinding(spec, input.plan);
    const issued = await this.options.lease.issue({
      plan: input.plan,
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: input.runtimeEpoch,
      turnId: input.turnId,
    });
    if (
      !issued.token ||
      !issued.modelAlias ||
      this.#tokens.has(issued.token) ||
      this.#aliases.has(issued.modelAlias) ||
      session.prepared ||
      session.busy ||
      session.running ||
      session.failed ||
      this.#sessions.get(spec.hostSessionId) !== session
    ) {
      if (issued.token && !this.#tokens.has(issued.token))
        this.options.lease.gateway.revokeToken(issued.token);
      throw new Error("Codex turn lease missing, reused or stale");
    }
    this.#tokens.add(issued.token);
    this.#aliases.add(issued.modelAlias);
    session.prepared = {
      turnId: input.turnId,
      runtimeEpoch: input.runtimeEpoch,
      plan: input.plan,
      ...issued,
    };
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const session = this.#require(command.hostSessionId);
    if (session.finishing) await session.finishing;
    if (session.failed)
      throw new Error("Codex execution unknown; inspect history before explicit recovery");
    if (session.busy || session.running) throw new Error("Codex session busy");
    const prepared = session.prepared;
    if (
      !prepared ||
      prepared.turnId !== command.turnId ||
      prepared.runtimeEpoch !== session.binding.runtimeEpoch
    )
      throw new Error("Codex turn not prepared");
    session.busy = true;
    session.prepared = undefined;
    const token = prepared.token;
    let transport: Awaited<ReturnType<typeof createCodexTransport>> | undefined;
    let turn: RunningCodexTurn | undefined;
    try {
      session.plan = prepared.plan;
      // 修复：原生 cwd 只能来自该 worktree 的当前 realpath，避免创建后目录指向外部。
      session.cwd = await this.#verifiedCwd(session.spec);
      if (session.cwd !== session.ownership.cwd)
        throw new Error("Codex native ownership cwd changed");
      // 修复：attach 后到实际 spawn 前 profile 仍可能丢失；不能只相信内存中的 threadId。
      const durable = await readNativeOwnership(
        session.profile,
        session.binding,
        session.spec,
        session.cwd,
      );
      if (JSON.stringify(durable) !== JSON.stringify(session.ownership))
        throw new Error("Codex native ownership changed");
      if (session.ownership.state === "never-started")
        session.ownership = await advanceNativeOwnership(
          session.profile,
          session.ownership,
          "starting",
        );
      else if (session.ownership.state !== "established")
        throw new Error("Codex native ownership unknown");
      transport = await createCodexTransport({
        cwd: session.cwd,
        sessionHome: session.profile,
        gatewayUrl: this.options.lease.gatewayUrl,
        gatewayToken: token,
        model: prepared.modelAlias,
        executable: this.options.executable,
        spawnProcess: this.options.spawnProcess,
        onEvent: (event) => this.#native(session, command.turnId, event),
        onFailure: () => {
          if (session.running?.turnId === command.turnId)
            void this.#finish(session, session.running, "unknown");
        },
      });
      const running = createRunningCodexTurn(command.turnId, token, transport);
      turn = running;
      session.running = running;
      if (session.threadId) {
        const resumed = await transport.resumeThread(session.threadId);
        if (resumed !== session.threadId) throw new Error("Codex native thread changed on resume");
      } else {
        // 修复依据：先记录原生 thread ID 再启动首个 turn；重启时绝不能重放已接受的 prompt。
        session.threadId = await transport.startThread();
        session.ownership = await advanceNativeOwnership(
          session.profile,
          session.ownership,
          "established",
          session.threadId,
        );
      }
      this.#emit(session, { kind: "turn.started", turnId: command.turnId });
      this.#emit(session, {
        kind: "message.finished",
        turnId: command.turnId,
        messageId: `user-${command.turnId}`,
        role: "user",
        text: command.text,
      });
      running.nativeTurnId = await transport.startTurn(session.threadId, command.text);
      // 修复原因：同线程旧 turn 的早到 completion 不能冒充 start 返回的原生 turn ID。
      const early = running.earlyCompletions.get(running.nativeTurnId);
      running.earlyCompletions.clear();
      running.earlyBytes = 0;
      for (const pending of running.earlyEvents.splice(0))
        if (isRecord(pending.params) && pending.params.turnId === running.nativeTurnId)
          this.#native(session, command.turnId, pending);
      if (early) await this.#finish(session, running, early);
      // 修复原因：Host 的 send 收据只在 adapter.send 完成后定案；若启动后立刻返回，
      // Host 会把仍在运行且等待审批的 prompt 记为 execution-unknown，阻断后续 turn。
      if ((await running.terminal) === "unknown")
        throw new Error("Codex execution unknown; inspect history before explicit recovery");
    } catch (error) {
      session.failed = true;
      if (turn) await this.#finish(session, turn, "unknown");
      else {
        // 修复：pre-ACK 溢出已经由 #finish 撤销 token；catch 不可再次撤销同一租约。
        this.options.lease.gateway.revokeToken(token);
        await transport?.close();
      }
      throw error;
    } finally {
      session.busy = false;
    }
  }
  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    const session = this.#require(command.hostSessionId);
    const running = session.running;
    if (
      !running ||
      running.turnId !== command.turnId ||
      session.binding.runtimeEpoch !== command.runtimeEpoch ||
      !running.nativeTurnId
    )
      throw new Error("stale Codex turn");
    try {
      // 修复依据：interrupt RPC 只确认请求已收到；必须等匹配的原生终态才可释放租约。
      await running.transport.interruptTurn(session.threadId!, running.nativeTurnId);
    } catch (error) {
      await this.#finish(session, running, "unknown");
      throw error;
    }
  }
  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    const session = this.#require(command.hostSessionId);
    const running = session.running;
    if (
      !running ||
      running.turnId !== command.turnId ||
      session.binding.runtimeEpoch !== command.runtimeEpoch
    )
      throw new Error("stale Codex approval");
    const callback = running.callbacks.get(command.interactionId);
    if (!callback) throw new Error("unknown Codex approval");
    running.callbacks.delete(command.interactionId);
    await running.transport.replyApproval(
      callback.interactionId,
      command.decision === "allow" ? "accept" : "decline",
    );
    this.#emit(session, {
      kind: "interaction.resolved",
      turnId: running.turnId,
      interactionId: command.interactionId,
      decision: command.decision,
    });
  }
  async terminate(hostSessionId: string): Promise<void> {
    const session = this.#require(hostSessionId);
    if (session.running) await this.#finish(session, session.running, "unknown");
    if (session.prepared) this.options.lease.gateway.revokeToken(session.prepared.token);
    this.#sessions.delete(hostSessionId);
  }
  async shutdown(): Promise<void> {
    for (const session of this.#sessions.values())
      if (session.running) await this.#finish(session, session.running, "unknown");
    for (const session of this.#sessions.values())
      if (session.prepared) this.options.lease.gateway.revokeToken(session.prepared.token);
    this.#sessions.clear();
  }
  subscribe(id: string, listener: (event: AgentEvent) => void): () => void {
    const listeners = this.#listeners.get(id) ?? new Set<(event: AgentEvent) => void>();
    listeners.add(listener);
    this.#listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(id);
    };
  }
  #native(session: Session, turnId: string, event: CodexNativeEvent): void {
    const running = session.running;
    if (!running || running.turnId !== turnId) return;
    if (event.kind === "approval") {
      if (
        event.params.threadId !== session.threadId ||
        event.params.turnId !== running.nativeTurnId
      )
        return;
      const interactionId = event.callbackId;
      running.callbacks.set(interactionId, {
        interactionId: event.callbackId,
        nativeItemId: String(event.params.itemId),
      });
      this.#emit(session, {
        kind: "interaction.requested",
        turnId,
        interactionId,
        toolCallId: String(event.params.itemId),
        summary:
          event.method === "item/fileChange/requestApproval"
            ? "Codex requests file changes"
            : "Codex requests command execution",
      });
      return;
    }
    const params = event.params;
    if (!isRecord(params) || params.threadId !== session.threadId) return;
    if (
      event.method === "turn/completed" &&
      isRecord(params.turn) &&
      typeof params.turn.id === "string"
    ) {
      const outcome =
        params.turn.status === "completed"
          ? "success"
          : params.turn.status === "interrupted"
            ? "cancelled"
            : "failed";
      if (!running.nativeTurnId) {
        const bytes = Buffer.byteLength(params.turn.id) + 64;
        // 修复：128 个巨大原生 ID 也可能耗尽内存；预 ACK 按计数及累计字节双限额。
        if (running.earlyCompletions.size >= 128 || running.earlyBytes + bytes > 1024 * 1024)
          void this.#finish(session, running, "unknown");
        else {
          running.earlyBytes += bytes;
          running.earlyCompletions.set(params.turn.id, outcome);
        }
      } else if (params.turn.id === running.nativeTurnId)
        void this.#finish(session, running, outcome);
    } else {
      // 修复：threadId 不能证明通知属于本 turn；无 turnId 的 usage/item/delta 一律丢弃。
      if (typeof params.turnId !== "string") return;
      if (!running.nativeTurnId) {
        const bytes = Buffer.byteLength(JSON.stringify(event));
        if (running.earlyEvents.length >= 128 || running.earlyBytes + bytes > 1024 * 1024) {
          void this.#finish(session, running, "unknown");
          return;
        }
        running.earlyBytes += bytes;
        running.earlyEvents.push(event);
        return;
      }
      if (params.turnId !== running.nativeTurnId) return;
      projectCodexNotification(event, session.threadId!, turnId, (detail) =>
        this.#emit(session, detail),
      );
    }
  }
  async #finish(
    session: Session,
    running: RunningCodexTurn,
    outcome: "success" | "cancelled" | "failed" | "unknown",
  ): Promise<void> {
    if (running.finish) return running.finish;
    // 修复原因：旧进程的迟到通知不能撤销新 turn 的 token，也不能写入新 turn 的事件序列。
    if (session.running === running) {
      if (outcome === "unknown") session.failed = true;
      session.running = undefined;
      this.#emit(session, { kind: "turn.finished", turnId: running.turnId, outcome });
    }
    this.options.lease.gateway.revokeToken(running.token);
    running.settle(outcome);
    running.finish = running.transport.close();
    session.finishing = running.finish;
    try {
      await running.finish;
    } finally {
      if (session.finishing === running.finish) session.finishing = undefined;
    }
  }
  #emit(session: Session, details: Record<string, unknown>): void {
    const event = agentEventSchema.parse({
      ...details,
      hostSessionId: session.spec.hostSessionId,
      runtimeEpoch: session.binding.runtimeEpoch,
      sequence: ++session.sequence,
      eventId: randomUUID(),
      at: Date.now(),
    });
    for (const listener of this.#listeners.get(session.spec.hostSessionId) ?? []) listener(event);
  }
  async #verifiedCwd(spec: SessionSpecV2): Promise<string> {
    // 修复：相对 cwd 由 Host 验证后传入；再次 realpath 防止符号链接逃出工作树。
    const root = await realpath(spec.execution.worktreePath);
    const cwd = await realpath(resolve(root, spec.execution.cwdRelativeToWorktree));
    const within = relative(root, cwd);
    if (
      within === ".." ||
      within.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
      isAbsolute(within)
    )
      throw new Error("Codex cwd outside verified worktree");
    return cwd;
  }
  #require(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new Error("Codex session not attached");
    return session;
  }
}
