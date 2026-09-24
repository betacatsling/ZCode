import type { CodexTransport } from "./codexTransport.js";

export type CodexTurnOutcome = "success" | "cancelled" | "failed" | "unknown";

export interface RunningCodexTurn {
  turnId: string;
  nativeTurnId?: string;
  token: string;
  transport: CodexTransport;
  callbacks: Map<string, { interactionId: string; nativeItemId: string }>;
  finish?: Promise<void>;
  earlyCompletion?: Exclude<CodexTurnOutcome, "unknown">;
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
  return { turnId, token, transport, callbacks: new Map(), terminal, settle };
}
