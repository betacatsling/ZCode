import type { AgentEvent } from "@zcode/shared/agent-host";

type UsageEvent = Extract<AgentEvent, { kind: "usage.accounted" | "usage.reported" }>;
type Metrics = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
};
const fields = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;
type Account = { mode: "delta" | "absolute"; kind: UsageEvent["kind"]; metrics: Metrics };

/** Pure ledger, scoped by turn AND backend call; no inferred zero for missing metrics. */
export class UsageAccounting {
  readonly #sources = new Map<string, Account>();
  readonly #legacy = new Set<string>();
  readonly #scopedTurns = new Set<string>();
  #totals: Metrics = {};

  record(event: UsageEvent): void {
    this.prepare(event)();
  }

  /** Validate without mutation; call the returned commit only after the journal cursor is durable. */
  prepare(event: UsageEvent): () => void {
    if (
      event.kind === "usage.reported" &&
      (event.sourceId === undefined) !== (event.accounting === undefined)
    )
      throw new Error("usage report identity requires sourceId and accounting together");
    const sourceId = event.sourceId;
    if (sourceId === undefined) {
      // 旧 journal 不带 source ID；只在整个 turn 都未混入新计量时保留逐事件累加语义。
      if (this.#scopedTurns.has(event.turnId)) throw new Error("ambiguous mixed legacy usage");
      return () => {
        this.#legacy.add(event.turnId);
        this.#add({ inputTokens: event.inputTokens, outputTokens: event.outputTokens });
      };
    }
    if (this.#legacy.has(event.turnId)) throw new Error("ambiguous mixed legacy usage");
    const key = `${JSON.stringify(event.turnId)}:${sourceId}`;
    const previous = this.#sources.get(key);
    if (previous && previous.kind !== event.kind)
      throw new Error("usage source collision across kinds");
    const mode = event.accounting;
    if (previous && previous.mode !== mode) throw new Error("usage accounting mode changed");
    if (previous && mode === "delta") throw new Error("duplicate usage delta source");
    const metrics: Metrics = { inputTokens: event.inputTokens, outputTokens: event.outputTokens };
    if (event.kind === "usage.accounted") {
      metrics.cacheReadTokens = event.cacheReadTokens;
      metrics.cacheWriteTokens = event.cacheWriteTokens;
      metrics.reasoningTokens = event.reasoningTokens;
    }
    if (previous)
      for (const field of fields) {
        if (previous.metrics[field] !== undefined && metrics[field] === undefined)
          throw new Error("usage snapshot omitted prior metric");
        if (
          previous.metrics[field] !== undefined &&
          metrics[field] !== undefined &&
          metrics[field]! < previous.metrics[field]!
        )
          throw new Error("usage absolute source regressed");
      }
    return () => {
      this.#add(metrics, previous?.metrics);
      this.#sources.set(key, { kind: event.kind, mode: mode!, metrics });
      this.#scopedTurns.add(event.turnId);
    };
  }

  #add(next: Metrics, previous?: Metrics): void {
    for (const field of fields) {
      const value = next[field];
      if (value === undefined) continue;
      this.#totals[field] = (this.#totals[field] ?? 0) + value - (previous?.[field] ?? 0);
    }
  }

  totals(): Readonly<Metrics> {
    return { ...this.#totals };
  }
}
