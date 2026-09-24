import { randomUUID } from "node:crypto";
import type { AgentEvent, BackendBindingV2, SessionSpecV2 } from "@zcode/shared/agent-host";
import type { ClaudeGatewayLease } from "./contract.js";
import type { ClaudeCodeTransport, ClaudeTransportEvent } from "./claudeTransport.js";
import { projectClaudeEvent } from "./claudeProjection.js";

export interface ClaudeTurn {
  id: string;
  transport?: ClaudeCodeTransport;
  token: string;
  revoked: boolean;
  terminalEmitted: boolean;
  assistantText: string;
  interactions: Map<string, string>;
  tools: Map<string, string>;
  cancelled: boolean;
  done: Promise<void>;
  settle(): void;
}
export interface ClaudeRuntime {
  spec: SessionSpecV2;
  binding: BackendBindingV2;
  dir: string;
  cwd: string;
  sequence: number;
  committed: boolean;
  uncertain?: boolean;
  prepared?: { turnId: string; epoch: string; token: string; nativeModelId: string };
  turn?: ClaudeTurn;
}
export type ClaudeEventPayload = AgentEvent extends infer E
  ? E extends AgentEvent
    ? Omit<E, "hostSessionId" | "runtimeEpoch" | "sequence" | "eventId" | "at" | "turnId"> & {
        kind: E["kind"];
      }
    : never
  : never;

export function reserveClaudeTurn(id: string, token: string): ClaudeTurn {
  let settle!: () => void;
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });
  return {
    id,
    token,
    revoked: false,
    terminalEmitted: false,
    assistantText: "",
    interactions: new Map(),
    tools: new Map(),
    cancelled: false,
    done,
    settle,
  };
}
export function revokeClaudeTurn(turn: ClaudeTurn, gateway: ClaudeGatewayLease): void {
  if (turn.revoked) return;
  turn.revoked = true;
  gateway.revokeToken(turn.token);
}
export function emitClaudeEvent(
  runtime: ClaudeRuntime,
  turnId: string,
  payload: ClaudeEventPayload,
  listeners: ReadonlySet<(event: AgentEvent) => void> | undefined,
): void {
  const event = {
    ...payload,
    hostSessionId: runtime.spec.hostSessionId,
    runtimeEpoch: runtime.binding.runtimeEpoch,
    sequence: ++runtime.sequence,
    eventId: randomUUID(),
    at: Date.now(),
    turnId,
  } as AgentEvent;
  for (const listener of listeners ?? []) listener(event);
}
export function projectNativeClaudeEvent(
  runtime: ClaudeRuntime,
  turn: ClaudeTurn,
  event: ClaudeTransportEvent,
): ClaudeEventPayload[] {
  if (event.type === "text") turn.assistantText += event.text;
  return projectClaudeEvent(
    runtime.binding.backendSessionId,
    {
      ...turn,
      transport: turn.transport!,
    },
    event,
  );
}
