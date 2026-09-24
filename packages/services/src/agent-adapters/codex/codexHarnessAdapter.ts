import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  agentEventSchema,
  type AgentCommand,
  type AgentEvent,
  type BackendBinding,
  type BindingPlan,
  type ExecutionTarget,
  type HarnessCapabilities,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../../agent-host/harnessRegistry.js";
import { createCodexTransport, type CodexNativeEvent } from "./codexTransport.js";
import { createRunningCodexTurn, type RunningCodexTurn } from "./codexTurnRuntime.js";
import { probeCodexVersion } from "./codexLaunch.js";
import type { CodexTurnLeaseIssuer } from "./codexAdapterContract.js";
import { projectCodexNotification } from "./codexCanonicalProjection.js";
import { assertCodexBinding, codexSessionProfile } from "./codexBinding.js";

interface Session {
  spec: SessionSpec;
  plan: BindingPlan;
  binding: BackendBinding;
  profile: string;
  threadId?: string;
  sequence: number;
  running?: RunningCodexTurn;
  busy: boolean;
  finishing?: Promise<void>;
  failed?: boolean;
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
      /** Host-authoritative per-turn replan; absence pins the initial selection. */
      resolveTurnPlan?: (
        spec: SessionSpec,
        previous: BindingPlan,
        turnId: string,
      ) => Promise<BindingPlan>;
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
  async create(spec: SessionSpec, plan: BindingPlan): Promise<BackendBinding> {
    assertCodexBinding(spec, plan);
    if (this.#sessions.has(spec.hostSessionId)) throw new Error("duplicate Codex session");
    const profile = codexSessionProfile(this.options.root, spec);
    await mkdir(profile, { recursive: true, mode: 0o700 });
    const binding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: randomUUID(),
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    };
    this.#sessions.set(spec.hostSessionId, {
      spec,
      plan,
      binding,
      profile,
      sequence: 0,
      busy: false,
    });
    return binding;
  }
  async attach(
    spec: SessionSpec,
    binding: BackendBinding,
    sequence: number,
    plan: BindingPlan,
  ): Promise<void> {
    assertCodexBinding(spec, plan);
    const existing = this.#sessions.get(spec.hostSessionId);
    if (existing) {
      if (
        existing.binding.backendSessionId !== binding.backendSessionId ||
        existing.binding.runtimeEpoch !== binding.runtimeEpoch
      )
        throw new Error("stale Codex binding");
      return;
    }
    const profile = codexSessionProfile(this.options.root, spec);
    let threadId: string | undefined;
    try {
      threadId = (
        await readFile(join(profile, `${binding.backendSessionId}.thread`), "utf8")
      ).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.#sessions.set(spec.hostSessionId, {
      spec,
      binding,
      plan,
      profile,
      threadId,
      sequence,
      busy: false,
    });
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const session = this.#require(command.hostSessionId);
    if (session.finishing) await session.finishing;
    if (session.failed)
      throw new Error("Codex execution unknown; inspect history before explicit recovery");
    if (session.busy || session.running) throw new Error("Codex session busy");
    session.busy = true;
    let token: string | undefined;
    let transport: Awaited<ReturnType<typeof createCodexTransport>> | undefined;
    try {
      const nextPlan = this.options.resolveTurnPlan
        ? await this.options.resolveTurnPlan(session.spec, session.plan, command.turnId)
        : session.plan;
      assertCodexBinding(session.spec, nextPlan);
      const issued = await this.options.lease.issue({
        plan: nextPlan,
        hostSessionId: command.hostSessionId,
        runtimeEpoch: session.binding.runtimeEpoch,
        turnId: command.turnId,
      });
      session.plan = nextPlan;
      token = issued.token;
      if (
        !token ||
        !issued.modelAlias ||
        this.#tokens.has(token) ||
        this.#aliases.has(issued.modelAlias)
      ) {
        // 修复原因：碰撞 token 仍属于上一 turn，不能由新 turn 撤销它。
        token = undefined;
        throw new Error("Codex turn lease is missing or reused");
      }
      this.#tokens.add(token);
      this.#aliases.add(issued.modelAlias);
      transport = await createCodexTransport({
        cwd: session.spec.execution.worktreePath,
        sessionHome: session.profile,
        gatewayUrl: this.options.lease.gatewayUrl,
        gatewayToken: token,
        model: issued.modelAlias,
        executable: this.options.executable,
        spawnProcess: this.options.spawnProcess,
        onEvent: (event) => this.#native(session, command.turnId, event),
        onFailure: () => {
          if (session.running?.turnId === command.turnId)
            void this.#finish(session, session.running, "unknown");
        },
      });
      const running = createRunningCodexTurn(command.turnId, token, transport);
      session.running = running;
      if (session.threadId) {
        const resumed = await transport.resumeThread(session.threadId);
        if (resumed !== session.threadId) throw new Error("Codex native thread changed on resume");
      } else {
        // 修复依据：先记录原生 thread ID 再启动首个 turn；重启时绝不能重放已接受的 prompt。
        session.threadId = await transport.startThread();
        const path = join(session.profile, `${session.binding.backendSessionId}.thread`);
        const temp = `${path}.${randomUUID()}.tmp`;
        await writeFile(temp, session.threadId, { mode: 0o600, flag: "wx" });
        await rename(temp, path);
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
      if (running.earlyCompletion) await this.#finish(session, running, running.earlyCompletion);
      // 修复原因：Host 的 send 收据只在 adapter.send 完成后定案；若启动后立刻返回，
      // Host 会把仍在运行且等待审批的 prompt 记为 execution-unknown，阻断后续 turn。
      if ((await running.terminal) === "unknown")
        throw new Error("Codex execution unknown; inspect history before explicit recovery");
    } catch (error) {
      session.failed = true;
      if (session.running) await this.#finish(session, session.running, "unknown");
      else {
        if (token) this.options.lease.gateway.revokeToken(token);
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
      await running.transport.interruptTurn(session.threadId!, running.nativeTurnId);
    } finally {
      await this.#finish(session, running, "cancelled");
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
    this.#sessions.delete(hostSessionId);
  }
  async shutdown(): Promise<void> {
    for (const session of this.#sessions.values())
      if (session.running) await this.#finish(session, session.running, "unknown");
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
      if (!running.nativeTurnId) running.earlyCompletion = outcome;
      else if (params.turn.id === running.nativeTurnId)
        void this.#finish(session, running, outcome);
    } else
      projectCodexNotification(event, session.threadId!, turnId, (detail) =>
        this.#emit(session, detail),
      );
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
  #require(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new Error("Codex session not attached");
    return session;
  }
}
