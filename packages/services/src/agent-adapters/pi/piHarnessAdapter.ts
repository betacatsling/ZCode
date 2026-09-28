import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { Model } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type {
  AgentCommand,
  AgentEvent,
  BackendBinding,
  BindingPlan,
  ExecutionTarget,
  HarnessCapabilities,
  SessionSpec,
} from "@zcode/shared/agent-host";
import type { HarnessAdapter, PreparedHostBinding } from "../../agent-host/harnessRegistry.js";
import { piHarnessCapabilities, piHarnessHostManagedSupport } from "./piCapabilities.js";
import type { FromPiWorker, PiWorkerBoot } from "./piProtocol.js";
import { PiSessionStartupReservations, waitForPiWorkerReady } from "./piSessionStartup.js";
import {
  failPiWorkerRuntime,
  routePiWorkerMessage,
  sendPiWorkerCommand,
} from "./piWorkerMessageRouter.js";

/** Source-mode Workers need Node >=24 so `--import tsx` loads `.ts` (and deps like node:sqlite). */
function assertPiWorkerNodeRuntime(): void {
  const major = Number(process.versions.node.split(".")[0] ?? 0);
  if (Number.isFinite(major) && major >= 24) return;
  throw new Error(
    `Pi worker requires Node.js >=24.0.0 (engines); current process is ${process.versions.node}`,
  );
}

function piWorkerExecArgv(sourceMode: boolean): string[] | undefined {
  if (!sourceMode) return undefined;
  try {
    const require = createRequire(import.meta.url);
    return ["--import", require.resolve("tsx")];
  } catch {
    return ["--import", "tsx"];
  }
}

interface Pending {
  resolve(): void;
  reject(error: Error): void;
}
interface Runtime {
  worker: Worker;
  binding: BackendBinding;
  lastSequence: number;
  model: Model;
  activeModel?: Model;
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
  readonly #modelFactory: (spec: SessionSpec, plan: BindingPlan) => Promise<Model> | Model;
  readonly #sessions = new Map<string, Runtime>();
  readonly #starts = new PiSessionStartupReservations<Runtime>();
  readonly #subscriptions = new Map<string, Set<(event: AgentEvent) => void>>();
  #shuttingDown = false;
  #shutdownPromise?: Promise<void>;

  constructor(options: {
    root: string;
    modelFactory: (spec: SessionSpec, plan: BindingPlan) => Promise<Model> | Model;
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
    return {
      support: "supported" as const,
      reason:
        "Pi worker probe only checks an available macOS or Linux target on this process platform. It does not certify resumeExecution, images, or modelSwitch.",
    };
  }
  async hostManagedSupport(target: ExecutionTarget, selection: ModelSelection) {
    return piHarnessHostManagedSupport(await this.probe(target), selection);
  }
  async capabilities(_target: ExecutionTarget): Promise<HarnessCapabilities> {
    return piHarnessCapabilities();
  }
  async prepareModel(spec: SessionSpec, plan: BindingPlan): Promise<Model> {
    return this.#modelFactory(spec, plan);
  }
  async prepareTurn(spec: SessionSpec, prepared: PreparedHostBinding): Promise<void> {
    const runtime = this.#require(spec.hostSessionId);
    if (runtime.failed) throw runtime.failed;
    if (
      prepared.plan.hostSessionId !== spec.hostSessionId ||
      prepared.plan.harnessId !== this.id ||
      prepared.plan.adapterVersion !== this.version ||
      prepared.plan.targetId !== spec.execution.targetId ||
      prepared.plan.route !== this.hostManagedRoute ||
      !prepared.turnId ||
      !prepared.model ||
      prepared.model.providerId !== prepared.plan.effective?.providerId ||
      prepared.model.modelId !== prepared.plan.effective?.modelId
    ) {
      throw new Error("Pi turn binding differs from the prepared Host model");
    }
  }
  async discardPreparedTurn(_spec: SessionSpec, _prepared: PreparedHostBinding): Promise<void> {}
  async create(
    spec: SessionSpec,
    plan: BindingPlan,
    prepared?: PreparedHostBinding,
  ): Promise<BackendBinding> {
    this.#assertCanStart(spec.hostSessionId);
    const binding: BackendBinding = {
      hostSessionId: spec.hostSessionId,
      backendSessionId: "pending",
      backendVersion: this.version,
      runtimeEpoch: randomUUID(),
    };
    const start = this.#starts.reserve(spec.hostSessionId, () =>
      this.#spawn(spec, plan, binding, false, 0, prepared),
    );
    try {
      const runtime = await start;
      if (this.#shuttingDown) {
        await runtime.worker.terminate();
        throw new Error("Pi target host is shutting down");
      }
      this.#sessions.set(spec.hostSessionId, runtime);
      return runtime.binding;
    } finally {
      this.#starts.release(spec.hostSessionId, start);
    }
  }
  async attach(
    spec: SessionSpec,
    binding: BackendBinding,
    lastJournalSequence: number,
    plan: BindingPlan,
    prepared?: PreparedHostBinding,
  ): Promise<void> {
    if (this.#shuttingDown) throw new Error("Pi target host is shutting down");
    const existing = this.#sessions.get(spec.hostSessionId);
    if (existing) {
      if (
        existing.binding.backendSessionId !== binding.backendSessionId ||
        existing.binding.runtimeEpoch !== binding.runtimeEpoch
      )
        throw new Error("stale Pi binding");
      return;
    }
    if (this.#starts.has(spec.hostSessionId)) throw new Error("Pi session is already starting");
    const start = this.#starts.reserve(spec.hostSessionId, () =>
      this.#spawn(spec, plan, binding, true, lastJournalSequence, prepared),
    );
    try {
      const runtime = await start;
      if (this.#shuttingDown) {
        await runtime.worker.terminate();
        throw new Error("Pi target host is shutting down");
      }
      this.#sessions.set(spec.hostSessionId, runtime);
    } finally {
      this.#starts.release(spec.hostSessionId, start);
    }
  }
  async send(
    command: Extract<AgentCommand, { type: "send" }>,
    prepared?: PreparedHostBinding,
  ): Promise<void> {
    const runtime = this.#require(command.hostSessionId);
    const model = prepared?.model ?? runtime.model;
    if (
      prepared &&
      (prepared.plan.hostSessionId !== command.hostSessionId ||
        (prepared.turnId !== undefined && prepared.turnId !== command.turnId) ||
        model.providerId !== prepared.plan.effective?.providerId ||
        model.modelId !== prepared.plan.effective?.modelId)
    ) {
      throw new Error("Pi send binding differs from its admitted turn plan");
    }
    runtime.activeModel = model;
    let request: Promise<void>;
    try {
      request = sendPiWorkerCommand(runtime, command.commandId, {
        type: "send",
        commandId: command.commandId,
        turnId: command.turnId,
        text: command.text,
      });
    } catch (error) {
      runtime.activeModel = undefined;
      throw error;
    }
    return request.finally(() => {
      if (runtime.activeModel === model) runtime.activeModel = undefined;
    });
  }
  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>): Promise<void> {
    return sendPiWorkerCommand(this.#require(command.hostSessionId), command.commandId, {
      type: "cancel",
      commandId: command.commandId,
      turnId: command.turnId,
    });
  }
  async resolveInteraction(
    command: Extract<AgentCommand, { type: "resolveInteraction" }>,
  ): Promise<void> {
    return sendPiWorkerCommand(this.#require(command.hostSessionId), command.commandId, {
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
    await sendPiWorkerCommand(runtime, commandId, { type: "terminate", commandId });
    this.#sessions.delete(hostSessionId);
    await runtime.worker.terminate();
  }
  async shutdown(): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#shuttingDown = true;
    this.#shutdownPromise = this.#finishShutdown();
    return this.#shutdownPromise;
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
    spec: SessionSpec,
    plan: BindingPlan,
    binding: BackendBinding,
    attach: boolean,
    sequence: number,
    prepared?: PreparedHostBinding,
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
    if (prepared && prepared.plan !== plan)
      throw new Error("Pi startup received a different prepared binding plan");
    const model = prepared?.model ?? (await this.#modelFactory(spec, plan));
    if (model.providerId !== plan.effective.providerId || model.modelId !== plan.effective.modelId)
      throw new Error("Pi model executor changed the requested route");
    const reasoningLevel = model.options.reasoningLevel;
    if (reasoningLevel !== "off" && reasoningLevel !== "low")
      throw new Error("Pi bridge supports only reasoningLevel=off or low");
    const digest = createHash("sha256")
      .update(
        JSON.stringify([
          spec.execution.targetId,
          spec.execution.workspaceIdentity,
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
      model: {
        providerId: model.providerId,
        modelId: model.modelId,
        ...(model.displayName ? { displayName: model.displayName } : {}),
        properties: { contextWindow: model.properties.contextWindow },
        optionSpecs: { maxOutputTokens: { max: model.optionSpecs.maxOutputTokens.max } },
        options: { reasoningLevel },
      },
    };
    assertPiWorkerNodeRuntime();
    const sourceMode = import.meta.url.endsWith(".ts");
    const execArgv = piWorkerExecArgv(sourceMode);
    const worker = new Worker(
      new URL(sourceMode ? "./piWorker.ts" : "./piWorker.js", import.meta.url),
      {
        workerData: boot,
        ...(execArgv ? { execArgv } : {}),
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
      binding,
      lastSequence: sequence,
      model,
      pending: new Map(),
      modelAborts: new Map(),
    };
    let backendSessionId: string;
    try {
      backendSessionId = await waitForPiWorkerReady(worker);
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
    worker.on("error", (error: Error) => failPiWorkerRuntime(runtime, error));
    worker.on("exit", () => failPiWorkerRuntime(runtime, new Error("Pi worker exited")));
    return runtime;
  }

  #require(hostSessionId: string): Runtime {
    const runtime = this.#sessions.get(hostSessionId);
    if (!runtime) throw new Error("Pi backend not attached");
    return runtime;
  }

  #assertCanStart(hostSessionId: string): void {
    if (this.#shuttingDown) throw new Error("Pi target host is shutting down");
    if (this.#sessions.has(hostSessionId) || this.#starts.has(hostSessionId))
      throw new Error("duplicate Pi session");
  }

  async #finishShutdown(): Promise<void> {
    // 先等已预留的 start 收敛，再取 worker 快照，避免 stale start 在关机后重新成为 owner。
    await this.#starts.settle();
    const workers = [...this.#sessions.values()];
    this.#sessions.clear();
    for (const runtime of workers)
      failPiWorkerRuntime(runtime, new Error("Pi target host shut down during execution"));
    await Promise.all(workers.map((runtime) => runtime.worker.terminate()));
  }
  #handleMessage(hostSessionId: string, runtime: Runtime, raw: FromPiWorker): void {
    routePiWorkerMessage({
      hostSessionId,
      runtime,
      message: raw,
      publishEvent: (event) => {
        for (const listener of this.#subscriptions.get(hostSessionId) ?? []) listener(event);
      },
      fail: (owner, error) => failPiWorkerRuntime(owner, error),
    });
  }
}
