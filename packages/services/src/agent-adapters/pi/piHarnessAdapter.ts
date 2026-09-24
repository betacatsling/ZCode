import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import type { Model } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type {
  AgentCommand,
  AgentEvent,
  BackendBindingV2,
  BindingPlan,
  ExecutionTarget,
  SessionSpecV2,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../../agent-host/harnessRegistry.js";
import type { FromPiWorker, PiWorkerBoot, ToPiWorker } from "./piProtocol.js";
import { piCapabilities } from "./piCapabilities.js";
import {
  forwardPiModelRequest,
  piModelInfo,
  resolvedCapture,
  type ModelCapture,
} from "./piModelTransport.js";

interface Pending {
  resolve(): void;
  reject(error: Error): void;
}
interface Runtime {
  worker: Worker;
  spec: SessionSpecV2;
  binding: BackendBindingV2;
  lastSequence: number;
  prepared?: { turnId: string; epoch: string; model: Model };
  pending: Map<string, Pending>;
  modelAborts: Map<string, AbortController>;
  failed?: Error;
}

/** Target-local Pi SDK worker; model calls remain in the existing ZCode model executor. */
export class PiHarnessAdapter implements HarnessAdapter {
  readonly id = "pi";
  readonly version = "0.87.1";
  readonly hostManagedRoute = "pi-sdk" as const;
  readonly #root: string;
  readonly #modelFactory: (
    spec: SessionSpecV2,
    plan: BindingPlan,
  ) => Promise<ModelCapture> | ModelCapture;
  readonly #sessions = new Map<string, Runtime>();
  readonly #subscriptions = new Map<string, Set<(event: AgentEvent) => void>>();

  constructor(options: {
    root: string;
    modelFactory: (spec: SessionSpecV2, plan: BindingPlan) => Promise<ModelCapture> | ModelCapture;
  }) {
    this.#root = options.root;
    this.#modelFactory = options.modelFactory;
  }

  async probe(target: ExecutionTarget) {
    if (!target.available)
      return { support: "unsupported" as const, reason: target.reason ?? "target unavailable" };
    if (target.platform !== "darwin" && target.platform !== "linux")
      return {
        support: "unsupported" as const,
        reason: "first release only supports macOS and Linux",
      };
    if (target.platform !== process.platform)
      return {
        support: "unsupported" as const,
        reason: "Pi worker must run on the execution target, not across an SSH stdio attachment",
      };
    return { support: "supported" as const };
  }
  async hostManagedSupport(target: ExecutionTarget, selection: ModelSelection) {
    const report = await this.probe(target);
    if (report.support !== "supported") return report;
    if (selection.options?.reasoningLevel !== "off")
      return {
        support: "unsupported" as const,
        reason: "Pi host bridge currently certifies only explicit reasoningLevel=off",
      };
    return report;
  }
  async capabilities(_target: ExecutionTarget) {
    return piCapabilities();
  }
  async create(spec: SessionSpecV2, plan: BindingPlan): Promise<BackendBindingV2> {
    if (this.#sessions.has(spec.hostSessionId)) throw new Error("duplicate Pi session");
    const binding: BackendBindingV2 = {
      schemaVersion: 2,
      hostSessionId: spec.hostSessionId,
      backendSessionId: "pending",
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
      targetId: spec.execution.targetId,
      workspaceId: spec.workspaceId,
      worktreeGeneration: spec.execution.worktreeGeneration,
      harnessId: spec.harness.id,
    };
    const runtime = await this.#spawn(spec, plan, binding, false, 0);
    this.#sessions.set(spec.hostSessionId, runtime);
    return runtime.binding;
  }
  async attach(
    spec: SessionSpecV2,
    binding: BackendBindingV2,
    lastJournalSequence: number,
    plan: BindingPlan,
  ): Promise<void> {
    if (
      binding.targetId !== spec.execution.targetId ||
      binding.workspaceId !== spec.workspaceId ||
      binding.worktreeGeneration !== spec.execution.worktreeGeneration ||
      binding.harnessId !== spec.harness.id
    )
      throw new Error("stale Pi target binding");
    const existing = this.#sessions.get(spec.hostSessionId);
    if (existing) {
      if (JSON.stringify(existing.spec) !== JSON.stringify(spec))
        throw new Error("stale Pi session spec");
      if (
        existing.binding.backendSessionId !== binding.backendSessionId ||
        existing.binding.runtimeEpoch !== binding.runtimeEpoch
      )
        throw new Error("stale Pi binding");
      return;
    }
    const runtime = await this.#spawn(spec, plan, binding, true, lastJournalSequence);
    this.#sessions.set(spec.hostSessionId, runtime);
  }
  async prepareTurn(
    spec: SessionSpecV2,
    input: { turnId: string; runtimeEpoch: string; plan: BindingPlan },
  ): Promise<void> {
    const runtime = this.#require(spec.hostSessionId);
    if (runtime.failed) throw runtime.failed;
    if (
      JSON.stringify(runtime.spec) !== JSON.stringify(spec) ||
      runtime.binding.runtimeEpoch !== input.runtimeEpoch ||
      runtime.prepared ||
      input.plan.hostSessionId !== spec.hostSessionId ||
      input.plan.targetId !== spec.execution.targetId ||
      input.plan.adapterVersion !== this.version ||
      input.plan.route !== "pi-sdk" ||
      input.plan.support.support !== "supported" ||
      input.plan.requested.kind !== "host-managed" ||
      !input.plan.effective ||
      JSON.stringify(input.plan.requested.selection) !==
        JSON.stringify(
          spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection : undefined,
        )
    ) {
      throw new Error("stale or mismatched Pi turn preparation");
    }
    const { model, identity } = resolvedCapture(await this.#modelFactory(spec, input.plan));
    if (
      model.providerId !== input.plan.effective.providerId ||
      model.modelId !== input.plan.effective.modelId ||
      model.options.reasoningLevel !== "off"
    )
      throw new Error("Pi prepared executor changed the selected route");
    const commandId = randomUUID();
    await this.#request(spec.hostSessionId, commandId, {
      type: "prepare",
      commandId,
      turnId: input.turnId,
      runtimeEpoch: input.runtimeEpoch,
      model: piModelInfo(model, identity),
    });
    runtime.prepared = { turnId: input.turnId, epoch: input.runtimeEpoch, model };
  }
  async send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    if (
      runtime.prepared?.turnId !== command.turnId ||
      runtime.prepared.epoch !== runtime.binding.runtimeEpoch
    )
      throw new Error("Pi turn was not prepared");
    try {
      return await this.#request(command.hostSessionId, command.commandId, {
        type: "send",
        commandId: command.commandId,
        turnId: command.turnId,
        text: command.text,
      });
    } finally {
      if (runtime.prepared?.turnId === command.turnId) runtime.prepared = undefined;
    }
  }
  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    return this.#request(command.hostSessionId, command.commandId, {
      type: "cancel",
      commandId: command.commandId,
      turnId: command.turnId,
    });
  }
  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    if (this.#require(command.hostSessionId).binding.runtimeEpoch !== command.runtimeEpoch)
      throw new Error("stale Pi approval epoch");
    return this.#request(command.hostSessionId, command.commandId, {
      type: "resolve",
      commandId: command.commandId,
      turnId: command.turnId,
      interactionId: command.interactionId,
      decision: command.decision,
    });
  }
  async terminate(hostSessionId: string): Promise<void> {
    const runtime = this.#require(hostSessionId);
    const commandId = randomUUID();
    await this.#request(hostSessionId, commandId, { type: "terminate", commandId });
    this.#sessions.delete(hostSessionId);
    await runtime.worker.terminate();
  }
  async shutdown(): Promise<void> {
    const workers = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const runtime of workers)
      this.#failRuntime(runtime, new Error("Pi target host shut down during execution"));
    await Promise.all(workers.map((runtime) => runtime.worker.terminate()));
  }
  subscribe(hostSessionId: string, listener: (event: AgentEvent) => void): () => void {
    let listeners = this.#subscriptions.get(hostSessionId);
    if (!listeners) {
      listeners = new Set();
      this.#subscriptions.set(hostSessionId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (!listeners!.size) this.#subscriptions.delete(hostSessionId);
    };
  }

  async #spawn(
    spec: SessionSpecV2,
    plan: BindingPlan,
    binding: BackendBindingV2,
    attach: boolean,
    sequence: number,
  ): Promise<Runtime> {
    if (
      plan.requested.kind !== "host-managed" ||
      plan.route !== this.hostManagedRoute ||
      plan.support.support !== "supported" ||
      !plan.effective
    ) {
      throw new Error("Pi worker requires a certified host-managed binding");
    }
    if (
      spec.harness.adapterVersion !== this.version ||
      plan.adapterVersion !== this.version ||
      plan.hostSessionId !== spec.hostSessionId ||
      plan.targetId !== spec.execution.targetId
    ) {
      throw new Error("Pi worker binding version or identity mismatch");
    }
    const root = await realpath(spec.execution.worktreePath);
    const cwd = await realpath(resolve(root, spec.execution.cwdRelativeToWorktree));
    const within = relative(root, cwd);
    // 修复：子目录必须以目标真实路径校验，词法路径会放行逃出 worktree 的符号链接。
    if (within === ".." || within.startsWith("../") || isAbsolute(within))
      throw new Error("Pi cwd escapes target worktree");
    const { model, identity } = resolvedCapture(await this.#modelFactory(spec, plan));
    if (model.providerId !== plan.effective.providerId || model.modelId !== plan.effective.modelId)
      throw new Error("Pi model executor changed the requested route");
    const reasoningLevel = model.options.reasoningLevel;
    if (reasoningLevel !== "off")
      throw new Error("Pi bridge requires the executor to bind reasoningLevel=off");
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          spec.execution.targetId,
          spec.workspaceId,
          spec.execution.workspaceIdentity,
          spec.execution.worktreeGeneration,
          root,
          cwd,
          spec.harness.id,
          spec.hostSessionId,
        ]),
      )
      .digest("hex");
    const sessionDir = join(this.#root, digest, "pi-sessions");
    const isolatedAgentDir = join(this.#root, digest, "pi-config");
    await mkdir(sessionDir, { recursive: true, mode: 0o700 });
    await mkdir(isolatedAgentDir, { recursive: true, mode: 0o700 });
    const boot: PiWorkerBoot = {
      spec,
      plan,
      binding,
      sessionDir,
      isolatedAgentDir,
      attach,
      sequence,
      model: piModelInfo(model, identity),
    };
    const sourceMode = import.meta.url.endsWith(".ts");
    const worker = new Worker(
      new URL(sourceMode ? "./piWorker.ts" : "./piWorker.js", import.meta.url),
      {
        workerData: boot,
        ...(sourceMode ? { execArgv: ["--import", "tsx"] } : {}),
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          HOME: isolatedAgentDir,
          LANG: process.env.LANG ?? "C.UTF-8",
          TMPDIR: process.env.TMPDIR ?? "/tmp",
        },
      },
    );
    const runtime: Runtime = {
      worker,
      spec,
      binding,
      lastSequence: sequence,
      pending: new Map(),
      modelAborts: new Map(),
    };
    const ready = new Promise<string>((resolve, reject) => {
      const onMessage = (raw: FromPiWorker) => {
        if (raw.type === "ready") {
          worker.off("error", reject);
          worker.off("exit", onExit);
          worker.off("message", onMessage);
          resolve(raw.backendSessionId);
        } else if (raw.type === "fatal") reject(new Error(raw.message));
      };
      const onExit = () => reject(new Error("Pi worker exited before session initialization"));
      worker.on("message", onMessage);
      worker.once("error", reject);
      worker.once("exit", onExit);
    });
    let backendSessionId: string;
    try {
      backendSessionId = await ready;
    } catch (error) {
      await worker.terminate();
      throw error;
    }
    if (attach && backendSessionId !== binding.backendSessionId) {
      await worker.terminate();
      throw new Error("Pi native session identity changed on attach");
    }
    runtime.binding = { ...binding, backendSessionId };
    worker.on("message", (raw: FromPiWorker) =>
      this.#handleMessage(spec.hostSessionId, runtime, raw),
    );
    worker.on("error", (error: Error) => this.#failRuntime(runtime, error));
    worker.on("exit", () => this.#failRuntime(runtime, new Error("Pi worker exited")));
    return runtime;
  }

  #request(hostSessionId: string, commandId: string, message: ToPiWorker): Promise<void> {
    const runtime = this.#require(hostSessionId);
    if (runtime.failed) return Promise.reject(runtime.failed);
    if (runtime.pending.has(commandId)) throw new Error("duplicate Pi command correlation ID");
    return new Promise((resolve, reject) => {
      runtime.pending.set(commandId, { resolve, reject });
      runtime.worker.postMessage(message);
    });
  }
  #require(hostSessionId: string): Runtime {
    const runtime = this.#sessions.get(hostSessionId);
    if (!runtime) throw new Error("Pi backend not attached");
    return runtime;
  }
  #handleMessage(hostSessionId: string, runtime: Runtime, raw: FromPiWorker): void {
    if (raw.type === "event") {
      const event = raw.event;
      if (
        event.hostSessionId !== hostSessionId ||
        event.runtimeEpoch !== runtime.binding.runtimeEpoch ||
        event.sequence !== runtime.lastSequence + 1
      ) {
        this.#failRuntime(runtime, new Error("Pi worker event sequence or identity mismatch"));
        return;
      }
      runtime.lastSequence = event.sequence;
      for (const listener of this.#subscriptions.get(hostSessionId) ?? []) listener(event);
    } else if (raw.type === "ack") {
      const pending = runtime.pending.get(raw.commandId);
      if (!pending) return;
      runtime.pending.delete(raw.commandId);
      if (raw.outcome === "completed") pending.resolve();
      else pending.reject(new Error("Pi operation failed"));
    } else if (raw.type === "model.request") {
      void forwardPiModelRequest(runtime, raw.requestId, raw.turnId, raw.request);
    } else if (raw.type === "model.abort") {
      runtime.modelAborts.get(raw.requestId)?.abort();
    } else if (raw.type === "fatal") this.#failRuntime(runtime, new Error(raw.message));
  }
  #failRuntime(runtime: Runtime, error: Error): void {
    if (runtime.failed) return;
    runtime.failed = error;
    runtime.prepared = undefined;
    for (const controller of runtime.modelAborts.values()) controller.abort();
    runtime.modelAborts.clear();
    for (const pending of runtime.pending.values()) pending.reject(error);
    runtime.pending.clear();
  }
}
