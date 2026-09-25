import type { CodexNativeEvent, CodexTransport } from "./codexTransport.js";

export type CodexTurnOutcome = "success" | "cancelled" | "failed" | "unknown";

export interface RunningCodexTurn {
  turnId: string;
  nativeTurnId?: string;
  token: string;
  transport: CodexTransport;
  callbacks: Map<string, { interactionId: string; nativeItemId: string }>;
  finish?: Promise<void>;
  earlyCompletions: Map<string, Exclude<CodexTurnOutcome, "unknown">>;
  earlyEvents: Array<Extract<CodexNativeEvent, { kind: "notification" }>>;
  earlyBytes: number;
  /** Wire-shape guard only; Host journal/projector remains the usage accounting owner. */
  knownUsageFields: Set<"inputTokens" | "outputTokens">;
  terminal: Promise<CodexTurnOutcome>;
  settle: (outcome: CodexTurnOutcome) => void;
}

/** The adapter's send promise remains pending until the native turn settles. */
export function createRunningCodexTurn(
  turnId: string,
  token: string,
  transport: CodexTransport,
): RunningCodexTurn {
  let settle!: RunningCodexTurn["settle"];
  const terminal: RunningCodexTurn["terminal"] = new Promise((resolve) => {
    settle = resolve;
  });
  return {
    turnId,
    token,
    transport,
    callbacks: new Map(),
    earlyCompletions: new Map(),
    earlyEvents: [],
    earlyBytes: 0,
    knownUsageFields: new Set(),
    terminal,
    settle,
  };
}
