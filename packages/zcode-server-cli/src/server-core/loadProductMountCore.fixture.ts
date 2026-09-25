/* Opt-in load diagnostic: the real Core authority owns Host admission and journal. */
import { runServerCore } from "./core.js";
import { createCoreAuthority, MockHarness, type HarnessAdapter } from "@zcode/services/node";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";
import {
  agentEventSchema,
  type AgentCommand,
  type AgentEvent,
  type SessionSpecV2,
} from "@zcode/shared/agent-host";

if (process.env.ZCODE_ACTUAL_SHELL_FIXTURE !== "1" || process.env.ZCODE_LOAD_PRODUCT_MOUNT !== "1")
  throw new Error("Opt-in isolated load product mount required");

class LoadProductHarness implements HarnessAdapter {
  readonly id = "load-product-synthetic";
  readonly version = "1.0.0";
  readonly hostManagedRoute = "mock" as const;
  readonly #base = new MockHarness();
  readonly #listeners = new Map<string, Set<(event: AgentEvent) => void>>();
  readonly #states = new Map<string, { epoch: string; sequence: number }>();
  readonly #runs = new Map<string, Promise<void>>();
  readonly #releases = new Map<string, (cancelled: boolean) => void>();
  probe: HarnessAdapter["probe"] = (target) => this.#base.probe(target);
  capabilities: HarnessAdapter["capabilities"] = (target) => this.#base.capabilities(target);
  hostManagedSupport: HarnessAdapter["hostManagedSupport"] = (target) =>
    this.#base.hostManagedSupport(target);
  async create(spec: SessionSpecV2) {
    const binding = await this.#base.create(spec);
    this.#states.set(spec.hostSessionId, { epoch: binding.runtimeEpoch, sequence: 0 });
    return binding;
  }
  async attach(
    spec: SessionSpecV2,
    binding: Parameters<HarnessAdapter["attach"]>[1],
    last: number,
  ) {
    await this.#base.attach(spec, binding);
    this.#states.set(spec.hostSessionId, { epoch: binding.runtimeEpoch, sequence: last });
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
  #emit(id: string, kind: AgentEvent["kind"], extra: Record<string, unknown>) {
    const state = this.#states.get(id);
    if (!state) throw new Error("Unknown load product session");
    const sequence = ++state.sequence;
    const event = agentEventSchema.parse({
      hostSessionId: id,
      runtimeEpoch: state.epoch,
      sequence,
      eventId: `${state.epoch}-load-${sequence}`,
      at: sequence,
      kind,
      ...extra,
    });
    for (const listener of this.#listeners.get(id) ?? []) listener(event);
  }
  send(command: Extract<AgentCommand, { type: "send" }>): Promise<void> {
    const id = command.hostSessionId;
    if (!this.#states.has(id) || this.#runs.has(id))
      throw new Error("Load product turn already running");
    this.#emit(id, "turn.started", { turnId: command.turnId });
    let release!: (cancelled: boolean) => void;
    const gate = new Promise<boolean>((resolve) => {
      release = resolve;
    });
    this.#releases.set(id, release);
    const run = (async () => {
      const cancelled = await gate;
      if (!cancelled) {
        const messageId = `load-message-${command.turnId}`;
        this.#emit(id, "text.delta", {
          turnId: command.turnId,
          messageId,
          text: "Core-owned load product output",
        });
        this.#emit(id, "message.finished", {
          turnId: command.turnId,
          messageId,
          role: "assistant",
          text: "Core-owned load product output",
        });
      }
      this.#emit(id, "turn.finished", {
        turnId: command.turnId,
        outcome: cancelled ? "cancelled" : "success",
      });
    })();
    this.#runs.set(id, run);
    void run.finally(() => {
      this.#runs.delete(id);
      this.#releases.delete(id);
    });
    process.send?.({ type: "load-turn-started", id });
    return run;
  }
  release(id: string) {
    const release = this.#releases.get(id);
    if (!release) throw new Error("No accepted load turn");
    release(false);
  }
  async cancelTurn(command: Extract<AgentCommand, { type: "cancelTurn" }>) {
    this.#releases.get(command.hostSessionId)?.(true);
    await this.#runs.get(command.hostSessionId);
  }
  async resolveInteraction() {
    throw new Error("No load interaction");
  }
  async terminate(id: string) {
    this.#releases.get(id)?.(true);
    await this.#runs.get(id);
    this.#states.delete(id);
  }
  async shutdown() {
    for (const release of this.#releases.values()) release(true);
    await Promise.all(this.#runs.values());
  }
}
const producer = new LoadProductHarness();
process.on("message", (message: unknown) => {
  if (
    message &&
    typeof message === "object" &&
    "command" in message &&
    message.command === "release-load" &&
    "id" in message &&
    typeof message.id === "string"
  )
    producer.release(message.id);
});
void (async () => {
  if (process.env.ZCODE_FIXTURE_INSTALL_ROOT)
    await ensureServerInstallOwnership(resolveServerLayout(process.env.ZCODE_FIXTURE_INSTALL_ROOT));
  await runServerCore(1, (options) =>
    createCoreAuthority({
      ...options,
      additionalTrustedHarnesses: [
        {
          manifest: {
            schemaVersion: 1,
            id: producer.id,
            name: "Load product synthetic (test only)",
            adapterVersion: producer.version,
          },
          factory: () => producer,
        },
      ],
    }),
  );
})().catch((error: unknown) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
