/* Opt-in synthetic backend inside the REAL Core authority, never a journal writer or replacement service. */
import { runServerCore } from "./core.js";
import { createCoreAuthority, MockHarness, type HarnessAdapter } from "@zcode/services/node";
import { IAgentHostService } from "@zcode/services";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";
import {
  agentEventSchema,
  type AgentCommand,
  type AgentEvent,
  type SessionSpecV2,
} from "@zcode/shared/agent-host";

if (process.env.ZCODE_ACTUAL_SHELL_FIXTURE !== "1" || !process.env.ZCODE_MOUNTED_HISTORY_FIXTURE)
  throw new Error("Isolated opt-in mounted history fixture required");

const ID = "synthetic-history";
const VERSION = "1.0.0";
// A short opt-in diagnostic can exercise the mounted controls; default acceptance is 100k+.
const SEED_EVENTS = Number(process.env.ZCODE_HISTORY_DIAGNOSTIC_EVENTS || 100_200);
const ROWS = 2_201;
if (!Number.isSafeInteger(SEED_EVENTS) || SEED_EVENTS < ROWS + 10 || SEED_EVENTS > 100_200)
  throw new Error("Invalid synthetic history event budget");
class ProducerStopped extends Error {}
class SyntheticHistoryHarness implements HarnessAdapter {
  readonly id = ID;
  readonly version = VERSION;
  readonly hostManagedRoute = "mock" as const;
  readonly #base = new MockHarness();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #epochs = new Map<string, string>();
  readonly #released = new Map<string, Array<() => void>>();
  readonly #stopped = new Set<string>();
  readonly #runs = new Map<string, Promise<void>>();
  readonly #kinds = new Map<string, Record<string, number>>();
  readonly #sequences = new Map<string, number>();
  #hostService: ReturnType<typeof getHostService> | undefined;

  bind(readonlyHost: ReturnType<typeof getHostService>) {
    this.#hostService = readonlyHost;
  }
  probe: HarnessAdapter["probe"] = (target) => this.#base.probe(target);
  capabilities: HarnessAdapter["capabilities"] = (target) => this.#base.capabilities(target);
  hostManagedSupport: HarnessAdapter["hostManagedSupport"] = (target) =>
    this.#base.hostManagedSupport(target);
  async create(spec: SessionSpecV2) {
    const binding = await this.#base.create(spec);
    this.#epochs.set(spec.hostSessionId, binding.runtimeEpoch);
    return binding;
  }
  async attach(
    spec: SessionSpecV2,
    binding: Parameters<HarnessAdapter["attach"]>[1],
    last: number,
  ) {
    await this.#base.attach(spec, binding);
    this.#epochs.set(spec.hostSessionId, binding.runtimeEpoch);
    this.#sequences.set(spec.hostSessionId, last);
  }
  subscribe(id: string, listener: (event: AgentEvent) => void) {
    const listeners = this.#listeners.get(id) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(id, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#listeners.delete(id);
    };
  }
  #emit(id: string, kind: AgentEvent["kind"], extra: Record<string, unknown>, terminal = false) {
    if (this.#stopped.has(id) && !terminal) throw new ProducerStopped();
    const sequence = (this.#sequences.get(id) ?? 0) + 1;
    let event: AgentEvent;
    try {
      event = agentEventSchema.parse({
        hostSessionId: id,
        runtimeEpoch: this.#epochs.get(id),
        sequence,
        eventId: `${id}-${sequence}`,
        at: sequence,
        kind,
        ...extra,
      });
    } catch (error) {
      process.send?.({ type: "history-producer-error", id, error: String(error) });
      throw error;
    }
    this.#sequences.set(id, sequence);
    const kinds = this.#kinds.get(id)!;
    kinds[kind] = (kinds[kind] ?? 0) + 1;
    for (const listener of this.#listeners.get(id) ?? []) listener(event);
  }
  async #committed(spec: SessionSpecV2, atLeast: number) {
    const read = this.#hostService;
    if (!read) throw new Error("Core Host readonly observer unavailable");
    // getSessionReadModel waits for SessionHost's *actual durable* event tail; not loop-counter evidence.
    if (atLeast > 2_200 && atLeast < 2_500)
      process.send?.({ type: "history-awaiting-commit", id: spec.hostSessionId, seq: atLeast });
    const model = await read.getSessionReadModel(spec);
    if (atLeast > 2_200 && atLeast < 2_500)
      process.send?.({ type: "history-observed-commit", id: spec.hostSessionId, seq: model.seq });
    if (model.seq < atLeast) throw new Error(`Core journal lag: ${model.seq} < ${atLeast}`);
  }
  #barrier(id: string): Promise<void> {
    return new Promise((resolve) => {
      const pending = this.#released.get(id) ?? [];
      pending.push(resolve);
      this.#released.set(id, pending);
    });
  }
  release(id: string) {
    const next = this.#released.get(id)?.shift();
    if (!next) throw new Error("No producer barrier to release");
    next();
  }
  send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const id = command.hostSessionId;
    if (this.#sequences.has(id)) throw new Error("synthetic history sends exactly once");
    this.#sequences.set(id, 0);
    this.#kinds.set(id, {});
    // 中文：Host 以此 Promise 追踪整轮执行；send 的接受回执不等待种子/屏障。
    const run = this.#produce(command);
    this.#runs.set(id, run);
    void run.then(
      () => this.#runs.delete(id),
      () => this.#runs.delete(id),
    );
    return run;
  }
  async #produce(command: Extract<AgentCommand, { type: "send" }>) {
    const id = command.hostSessionId;
    const turnId = command.turnId;
    const common = { turnId };
    process.send?.({ type: "history-started", id });
    const tool = { ...common, toolCallId: `early-tool-${turnId}`, name: "synthetic-read" };
    try {
      this.#emit(id, "turn.started", common);
      this.#emit(id, "tool.started", { ...tool, inputText: "early pending tool" });
      for (let i = 0; i < ROWS; i++) {
        this.#emit(id, "message.finished", {
          ...common,
          role: "assistant",
          messageId: `history-row-${i}`,
          text: `history marker ${i}`,
        });
        if (i % 128 === 127) {
          await this.#committedFromCommand(id, command);
          process.send?.({ type: "history-progress", id, seq: this.#sequences.get(id) });
        }
      }
      process.send?.({ type: "history-rows-emitted", id, seq: this.#sequences.get(id) });
      let row = 0;
      while ((this.#sequences.get(id) ?? 0) < SEED_EVENTS) {
        // 中文：每组是同一未结束消息的实际增量和终结，ID 唯一；不向已关闭行追加。
        const messageId = `history-stream-${row++}`;
        const chunks: string[] = [];
        const remaining = SEED_EVENTS - (this.#sequences.get(id) ?? 0);
        for (let part = 0; part < Math.min(32, remaining - 1); part++) {
          const text = `row ${row} segment ${part}; `;
          chunks.push(text);
          this.#emit(id, "text.delta", { ...common, messageId, text });
          if ((this.#sequences.get(id) ?? 0) % 128 === 0) {
            await this.#committedFromCommand(id, command);
            this.#ensureRunning(id);
          }
        }
        this.#emit(id, "message.finished", {
          ...common,
          role: "assistant",
          messageId,
          text: chunks.join("") || `row ${row} complete`,
        });
        if ((this.#sequences.get(id) ?? 0) % 128 === 0) {
          await this.#committedFromCommand(id, command);
          this.#ensureRunning(id);
          if ((this.#sequences.get(id) ?? 0) % 2_048 === 0)
            process.send?.({ type: "history-progress", id, seq: this.#sequences.get(id) });
        }
      }
      await this.#committedFromCommand(id, command);
      process.send?.({
        type: "history-seeded",
        id,
        seq: this.#sequences.get(id),
        kinds: { ...this.#kinds.get(id) },
      });
      await this.#barrier(id);
      this.#ensureRunning(id);
      for (let i = 0; i < 256; i++) {
        this.#emit(id, "message.finished", {
          ...common,
          role: "assistant",
          messageId: `history-append-${i}`,
          text: `appended marker ${i}`,
        });
        if (i % 128 === 127) {
          await this.#committedFromCommand(id, command);
          this.#ensureRunning(id);
        }
      }
      await this.#committedFromCommand(id, command);
      process.send?.({ type: "history-appended", id, seq: this.#sequences.get(id) });
      await this.#barrier(id);
      this.#ensureRunning(id);
      // 中文：旧工具只由原接受 turn/tool ID 的晚到结果更新；不能伪造历史版本或更改旧 source 序号。
      this.#emit(id, "tool.finished", {
        ...tool,
        outcome: "success",
        outputText: "old tool completed after append",
      });
      await this.#committedFromCommand(id, command);
      process.send?.({ type: "history-old-tool-finished", id, seq: this.#sequences.get(id) });
      // Keep the original turn running while the older visible tool row is checked in the Shell.
      await this.#barrier(id);
      this.#ensureRunning(id);
      this.#emit(id, "turn.finished", { ...common, outcome: "success" });
      await this.#committedFromCommand(id, command);
      process.send?.({
        type: "history-finished",
        id,
        seq: this.#sequences.get(id),
        kinds: { ...this.#kinds.get(id) },
      });
    } catch (error) {
      if (!(error instanceof ProducerStopped)) throw error;
      // 中文：仅已接受且真实中断的原轮次生成取消终结，不凭空补写历史；Host 收敛 activeTurn。
      this.#emit(id, "tool.finished", { ...tool, outcome: "cancelled" }, true);
      this.#emit(id, "turn.finished", { ...common, outcome: "cancelled" }, true);
      await this.#committedFromCommand(id, command);
      process.send?.({
        type: "history-cancelled",
        id,
        seq: this.#sequences.get(id),
        kinds: { ...this.#kinds.get(id) },
      });
    }
  }
  #ensureRunning(id: string) {
    if (this.#stopped.has(id)) throw new ProducerStopped();
  }
  async #committedFromCommand(id: string, command: Extract<AgentCommand, { type: "send" }>) {
    const spec = this.#specs.get(id);
    if (!spec || spec.hostSessionId !== command.hostSessionId)
      throw new Error("missing accepted Host spec");
    try {
      await this.#committed(spec, this.#sequences.get(id)!);
      if (this.#sequences.get(id)! % 8_192 === 0)
        process.send?.({ type: "history-progress", id, seq: this.#sequences.get(id) });
    } catch (error) {
      process.send?.({ type: "history-producer-error", id, error: String(error) });
      throw error;
    }
  }
  readonly #specs = new Map<string, SessionSpecV2>();
  async prepareTurn(spec: SessionSpecV2) {
    this.#specs.set(spec.hostSessionId, spec);
  }
  #stop(id: string) {
    this.#stopped.add(id);
    for (const resolve of this.#released.get(id) ?? []) resolve();
    this.#released.delete(id);
  }
  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>) {
    this.#stop(command.hostSessionId);
    await this.#runs.get(command.hostSessionId);
  }
  async resolveInteraction() {
    throw new Error("synthetic fixture has no interaction");
  }
  async terminate(id: string) {
    this.#stop(id);
    await this.#runs.get(id);
  }
  async shutdown() {
    for (const id of this.#runs.keys()) this.#stop(id);
    await Promise.all([...this.#runs.values()]);
  }
}

function getHostService(owner: Awaited<ReturnType<typeof createCoreAuthority>>) {
  return owner.services.get(IAgentHostService);
}
const producer = new SyntheticHistoryHarness();
process.on("message", (message: unknown) => {
  if (
    !message ||
    typeof message !== "object" ||
    !("command" in message) ||
    message.command !== "release-history"
  )
    return;
  if (!("id" in message) || typeof message.id !== "string") return;
  try {
    producer.release(message.id);
  } catch (error) {
    process.send?.({ type: "history-release-error", error: String(error) });
  }
});
void (async () => {
  if (process.env.ZCODE_FIXTURE_INSTALL_ROOT)
    await ensureServerInstallOwnership(resolveServerLayout(process.env.ZCODE_FIXTURE_INSTALL_ROOT));
  await runServerCore(1, async (options) => {
    const owner = await createCoreAuthority({
      ...options,
      additionalTrustedHarnesses: [
        {
          manifest: {
            schemaVersion: 1,
            id: ID,
            name: "Synthetic history (test only)",
            adapterVersion: VERSION,
          },
          factory: () => producer,
        },
      ],
    });
    producer.bind(getHostService(owner));
    return owner;
  });
})().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
