import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  backendBindingV2Schema,
  type AgentCommand,
  type AgentEvent,
  type BackendBindingV2,
  type BindingPlan,
  type CapabilityReport,
  type ExecutionTarget,
  type HarnessCapabilitiesV2,
  type SessionSpecV2,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../../agent-host/harnessRegistry.js";
import type { TrustedClaudeProfile } from "./contract.js";
import { ClaudeCodeTransport, type ClaudeTransportEvent } from "./claudeTransport.js";
import { checkClaudePlan, claudeCwd, claudeDir } from "./claudeSessionScope.js";
import {
  emitClaudeEvent,
  projectNativeClaudeEvent,
  reserveClaudeTurn,
  revokeClaudeTurn,
  type ClaudeRuntime as Runtime,
  type ClaudeTurn as Turn,
  type ClaudeEventPayload,
} from "./claudeTurnLifecycle.js";

const blocked = (reason: string): CapabilityReport => ({ support: "unsupported", reason });
const nativeGatewayBlock =
  "Pinned Claude Code 2.1.263 emits claude-code-20250219 beta; native Messages Gateway rejects it (422); profile not certified";
/** Target-local mechanics; unsupported Host capabilities until native Gateway wire profile is certified. */
export class ClaudeHarnessAdapter implements HarnessAdapter {
  readonly id = "claude-code";
  readonly version = "2.1.263";
  readonly hostManagedRoute = "messages-gateway" as const;
  readonly #sessions = new Map<string, Runtime>();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  private readonly profile: TrustedClaudeProfile;
  constructor(profile: TrustedClaudeProfile) {
    if (!isAbsolute(profile.root))
      throw new Error("Claude profile requires an absolute trusted root");
    this.profile = profile;
  }
  async probe(target: ExecutionTarget): Promise<CapabilityReport> {
    if (!target.available) return blocked(target.reason ?? "target unavailable");
    if (target.platform !== process.platform || target.kind !== "local")
      return blocked("Claude SDK process must launch on the verified local target");
    return blocked(nativeGatewayBlock);
  }
  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilitiesV2> {
    const no = blocked(nativeGatewayBlock);
    return {
      text: no,
      tools: no,
      approvals: no,
      cancelTurn: no,
      resumeExecution: blocked("Native resume of an uncertain turn cannot be inferred"),
      history: no,
      images: no,
      modelSwitch: no,
      detach: { support: "supported" },
      terminateSession: no,
      viewHistory: no,
      hostManagedModel: no,
      fork: no,
      subagents: no,
    };
  }
  async hostManagedSupport(
    _target: ExecutionTarget,
    _selection: ModelSelection,
  ): Promise<CapabilityReport> {
    return blocked(nativeGatewayBlock);
  }
  async create(spec: SessionSpecV2, plan: BindingPlan): Promise<BackendBindingV2> {
    checkClaudePlan(spec, plan);
    if (this.#sessions.has(spec.hostSessionId)) throw new Error("duplicate Claude session");
    const cwd = await claudeCwd(this.profile, spec);
    const dir = claudeDir(this.profile.root, spec);
    await mkdir(this.profile.root, { recursive: true, mode: 0o700 });
    // 修复：同一 Host ID 的旧目录可能含未提交的 native turn，不能覆盖旧绑定或重用会话历史。
    await mkdir(dir, { mode: 0o700 });
    const binding = backendBindingV2Schema.parse({
      schemaVersion: 2,
      hostSessionId: spec.hostSessionId,
      // SDK 0.3.263 options.sessionId supplies this UUID on first query; native init must confirm it.
      backendSessionId: randomUUID(),
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
      targetId: spec.execution.targetId,
      workspaceId: spec.workspaceId,
      worktreeGeneration: spec.execution.worktreeGeneration,
      harnessId: this.id,
    });
    this.#sessions.set(spec.hostSessionId, {
      spec,
      binding,
      dir,
      cwd,
      sequence: 0,
      committed: false,
    });
    return binding;
  }
  async attach(
    spec: SessionSpecV2,
    raw: BackendBindingV2,
    lastJournalSequence: number,
    plan: BindingPlan,
  ): Promise<void> {
    checkClaudePlan(spec, plan);
    const binding = backendBindingV2Schema.parse(raw);
    if (
      binding.hostSessionId !== spec.hostSessionId ||
      binding.targetId !== spec.execution.targetId ||
      binding.workspaceId !== spec.workspaceId ||
      binding.worktreeGeneration !== spec.execution.worktreeGeneration ||
      binding.harnessId !== this.id ||
      binding.backendVersion !== this.version ||
      !Number.isSafeInteger(lastJournalSequence) ||
      lastJournalSequence < 0
    )
      throw new Error("stale Claude binding");
    const existing = this.#sessions.get(spec.hostSessionId);
    if (existing) {
      if (
        JSON.stringify(existing.spec) !== JSON.stringify(spec) ||
        JSON.stringify(existing.binding) !== JSON.stringify(binding)
      )
        throw new Error("stale Claude binding");
      return;
    }
    const cwd = await claudeCwd(this.profile, spec);
    const dir = claudeDir(this.profile.root, spec);
    // 修复：既有成功 receipt 不能证明后续未完成的 native turn 未运行；inflight 意图必须优先阻断重放。
    try {
      await readFile(join(dir, "inflight.json"));
      throw new Error("uncommitted Claude native turn: explicit recovery required");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    let committed = false;
    try {
      const receipt = JSON.parse(await readFile(join(dir, "committed.json"), "utf8")) as {
        nativeId?: string;
        turnId?: string;
      };
      committed =
        receipt.nativeId === binding.backendSessionId &&
        typeof receipt.turnId === "string" &&
        !!receipt.turnId;
      if (!committed) throw new Error("Claude native receipt identity mismatch");
    } catch (error) {
      // 修复：只有确实缺少 receipt 的零事件绑定才可首次发送；损坏/错绑的收据不是新会话。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (lastJournalSequence > 0 && !committed)
      throw new Error("uncommitted Claude native state: explicit recovery required");
    // A committed receipt alone is not proof that an interrupted later turn did not run.
    if (committed && lastJournalSequence === 0)
      throw new Error("Claude journal and native receipt diverged");
    this.#sessions.set(spec.hostSessionId, {
      spec,
      binding,
      dir,
      cwd,
      committed,
      sequence: lastJournalSequence,
    });
  }
  async prepareTurn(
    spec: SessionSpecV2,
    input: { turnId: string; runtimeEpoch: string; plan: BindingPlan },
  ): Promise<void> {
    const runtime = this.#require(spec.hostSessionId);
    checkClaudePlan(spec, input.plan);
    if (
      JSON.stringify(runtime.spec) !== JSON.stringify(spec) ||
      runtime.binding.runtimeEpoch !== input.runtimeEpoch ||
      runtime.uncertain ||
      runtime.prepared ||
      runtime.turn ||
      !input.turnId
    )
      throw new Error("stale or already prepared Claude turn");
    const nativeModelId = this.profile.nativeModel(spec, input.plan);
    if (!nativeModelId || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(nativeModelId))
      throw new Error("invalid trusted native model identifier");
    const effective = input.plan.effective!;
    const token = await this.profile.gateway.issueToken({
      targetId: spec.execution.targetId,
      hostSessionId: spec.hostSessionId,
      runtimeEpoch: input.runtimeEpoch,
      turnId: input.turnId,
      protocol: "anthropic-messages",
      requestedModelAlias: nativeModelId,
      effectiveSelection: effective,
      expiresAt: Date.now() + 15 * 60_000,
      maxRequests: 128,
      maxOutputBytes: 16 * 1024 * 1024,
      maxGenerationTokens: 100_000,
      maxOutputTokensPerRequest: 32_000,
    });
    if (
      !token ||
      runtime.binding.runtimeEpoch !== input.runtimeEpoch ||
      runtime.prepared ||
      runtime.turn ||
      this.#sessions.get(spec.hostSessionId) !== runtime
    ) {
      if (token) this.profile.gateway.revokeToken(token);
      throw new Error("stale Claude turn after lease acquisition");
    }
    runtime.prepared = { turnId: input.turnId, epoch: input.runtimeEpoch, token, nativeModelId };
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    const prepared = runtime.prepared;
    if (
      !prepared ||
      prepared.turnId !== command.turnId ||
      prepared.epoch !== runtime.binding.runtimeEpoch ||
      runtime.turn
    )
      throw new Error("Claude turn not prepared");
    // 修复：意图写入是异步的；在第一次 await 之前保留完整 turn/lease 所有权，shutdown 才能看见并撤销它。
    const turn = reserveClaudeTurn(command.turnId, prepared.token);
    runtime.prepared = undefined;
    runtime.turn = turn;
    this.#emit(runtime, turn.id, { kind: "turn.started" });
    this.#emit(runtime, turn.id, {
      kind: "message.finished",
      role: "user",
      messageId: `${turn.id}:user`,
      text: command.text,
    });
    const assertOwned = () => {
      if (
        runtime.turn !== turn ||
        this.#sessions.get(command.hostSessionId) !== runtime ||
        turn.cancelled
      )
        throw new Error("Claude turn ownership revoked during shutdown or cancellation");
    };
    try {
      // 修复：SDK 前独占落盘意图；写入后再次检查 owner，禁止 shutdown 间隙启动无主子进程。
      const path = join(runtime.dir, "inflight.json");
      const contents = JSON.stringify({
        nativeId: runtime.binding.backendSessionId,
        turnId: turn.id,
      });
      if (this.profile.writeInflight) await this.profile.writeInflight(path, contents);
      else await writeFile(path, contents, { flag: "wx", mode: 0o600 });
      assertOwned();
      const transport = (
        this.profile.transportFactory ?? ((options) => new ClaudeCodeTransport(options))
      )({
        cwd: runtime.cwd,
        profileDir: runtime.dir,
        gatewayUrl: this.profile.gateway.url,
        gatewayToken: turn.token,
        model: prepared.nativeModelId,
        ...(runtime.committed
          ? { resumeId: runtime.binding.backendSessionId }
          : { sessionId: runtime.binding.backendSessionId }),
      });
      turn.transport = transport;
      assertOwned();
      const result = await transport.run(command.text, (event) =>
        this.#native(runtime, turn, event),
      );
      assertOwned();
      if (result.nativeSessionId !== runtime.binding.backendSessionId)
        throw new Error("Claude native identity or turn changed");
      // 修复：只在原生 result 与子进程零退出均确认后记录可恢复事实，绝不重放未知 prompt。
      const tmp = join(runtime.dir, `committed.${randomUUID()}.tmp`);
      await writeFile(tmp, JSON.stringify({ nativeId: result.nativeSessionId, turnId: turn.id }), {
        mode: 0o600,
      });
      assertOwned();
      await rename(tmp, join(runtime.dir, "committed.json"));
      assertOwned();
      runtime.committed = true;
      await rm(path);
      assertOwned();
      // Terminal replacement is authoritative for the same assistant message ID as the deltas.
      this.#emit(runtime, turn.id, {
        kind: "message.finished",
        role: "assistant",
        messageId: turn.id,
        text: turn.assistantText,
      });
      this.#finish(runtime, turn, "success");
    } catch (error) {
      runtime.uncertain = true;
      if (this.#sessions.get(command.hostSessionId) === runtime)
        this.#finish(runtime, turn, turn.cancelled ? "cancelled" : "unknown");
      throw error;
    } finally {
      turn.interactions.clear();
      turn.tools.clear();
      this.#revoke(turn);
      if (runtime.turn === turn) runtime.turn = undefined;
      turn.settle();
    }
  }
  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    const turn = runtime.turn;
    if (
      !turn ||
      turn.id !== command.turnId ||
      runtime.binding.runtimeEpoch !== command.runtimeEpoch
    )
      throw new Error("stale Claude cancel");
    turn.cancelled = true;
    this.#revoke(turn);
    turn.transport?.cancel();
  }
  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    const runtime = this.#require(command.hostSessionId),
      turn = runtime.turn;
    if (
      !turn ||
      turn.cancelled ||
      turn.id !== command.turnId ||
      runtime.binding.runtimeEpoch !== command.runtimeEpoch ||
      !turn.interactions.has(command.interactionId)
    )
      throw new Error("stale Claude approval");
    if (!turn.transport?.reply(command.interactionId, command.decision))
      throw new Error("late Claude approval");
    turn.interactions.delete(command.interactionId);
    this.#emit(runtime, turn.id, {
      kind: "interaction.resolved",
      interactionId: command.interactionId,
      decision: command.decision,
    });
  }
  async terminate(hostSessionId: string): Promise<void> {
    const runtime = this.#require(hostSessionId);
    const running = runtime.turn;
    if (running) {
      // 修复：先撤销租约并发布不确定终态，再移除 owner；后续异步写入/SDK 回调不得产生成功事件。
      running.cancelled = true;
      runtime.uncertain = true;
      this.#revoke(running);
      running.transport?.cancel();
      this.#finish(runtime, running, "unknown");
    }
    if (runtime.prepared) this.profile.gateway.revokeToken(runtime.prepared.token);
    this.#sessions.delete(hostSessionId);
    await running?.done;
  }
  async shutdown(): Promise<void> {
    await Promise.all([...this.#sessions.keys()].map((id) => this.terminate(id)));
  }
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    let listeners = this.#listeners.get(hostSessionId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(hostSessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) this.#listeners.delete(hostSessionId);
    };
  }
  #native(runtime: Runtime, turn: Turn, event: ClaudeTransportEvent): void {
    if (
      runtime.turn !== turn ||
      this.#sessions.get(runtime.spec.hostSessionId) !== runtime ||
      turn.cancelled ||
      turn.terminalEmitted
    )
      return;
    for (const payload of projectNativeClaudeEvent(runtime, turn, event))
      this.#emit(runtime, turn.id, payload);
  }
  #revoke(turn: Turn): void {
    revokeClaudeTurn(turn, this.profile.gateway);
  }
  #finish(runtime: Runtime, turn: Turn, outcome: "success" | "cancelled" | "unknown"): void {
    if (turn.terminalEmitted) return;
    turn.terminalEmitted = true;
    this.#emit(runtime, turn.id, { kind: "turn.finished", outcome });
  }
  #emit(runtime: Runtime, turnId: string, payload: ClaudeEventPayload): void {
    emitClaudeEvent(runtime, turnId, payload, this.#listeners.get(runtime.spec.hostSessionId));
  }
  #require(id: string): Runtime {
    const runtime = this.#sessions.get(id);
    if (!runtime) throw new Error("Claude session not attached");
    return runtime;
  }
}
