import type { Model } from "@zcode/contracts";
import type {
  AgentEvent,
  BackendBinding,
  BindingPlan,
  SessionSpec,
} from "@zcode/shared/agent-host";
import type { ModelGateway, ModelGatewayGrant } from "@zcode/services/model-gateway";
import type { ClaudeApprovalHookServer } from "../../src/agent-adapters/claude/claudeApprovalHookServer.js";
import type { ClaudeSessionProfile } from "../../src/agent-adapters/claude/claudeProfile.js";
import {
  createClaudeDecision,
  createClaudeTurnCompletion,
  type ClaudeActiveTurn,
  type ClaudeSessionRuntime,
} from "../../src/agent-adapters/claude/claudeRuntime.js";
import { ClaudeRuntimeEventSink } from "../../src/agent-adapters/claude/claudeRuntimeEventSink.js";
import type { ClaudeStreamProcess } from "../../src/agent-adapters/claude/claudeStreamProcess.js";

// Pure-unit fixtures for the Claude adapter modules: no CLI, no Gateway, no SessionHost.

export const CLAUDE_UNIT = {
  adapterId: "claude-code",
  adapterVersion: "2.1.263",
  route: "messages-gateway",
  hostSessionId: "claude-unit-session",
  targetId: "claude-unit-target",
  providerId: "claude-unit-provider",
  modelId: "claude-unit-model",
  fixtureId: "claude-unit-fixture",
  backendSessionId: "native-claude-unit",
  runtimeEpoch: "epoch-claude-unit",
} as const;

export function claudeUnitSpec(): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId: CLAUDE_UNIT.hostSessionId,
    execution: {
      targetId: CLAUDE_UNIT.targetId,
      workspaceIdentity: "identity-claude-unit",
      worktreePath: "/tmp/claude-unit-worktree",
    },
    harness: { id: CLAUDE_UNIT.adapterId, adapterVersion: CLAUDE_UNIT.adapterVersion },
    modelBinding: {
      kind: "host-managed",
      selection: {
        providerId: CLAUDE_UNIT.providerId as never,
        modelId: CLAUDE_UNIT.modelId as never,
        options: { reasoningLevel: "low" },
      },
    },
  };
}

export function claudeUnitPlan(spec: SessionSpec = claudeUnitSpec()): BindingPlan {
  const selection =
    spec.modelBinding.kind === "host-managed" ? spec.modelBinding.selection : undefined;
  return {
    schemaVersion: 1,
    hostSessionId: spec.hostSessionId,
    targetId: spec.execution.targetId,
    harnessId: CLAUDE_UNIT.adapterId,
    adapterVersion: CLAUDE_UNIT.adapterVersion,
    catalogFingerprint: "catalog-claude-unit",
    requested: structuredClone(spec.modelBinding),
    ...(selection ? { effective: structuredClone(selection) } : {}),
    route: CLAUDE_UNIT.route,
    support: {
      support: "supported",
      constraints: {
        compatibilityEvidence: "fake-model-fixture",
        fixtureId: CLAUDE_UNIT.fixtureId,
        fixtureProviderId: CLAUDE_UNIT.providerId,
        fixtureModelId: CLAUDE_UNIT.modelId,
      },
    },
    capabilities: {},
  };
}

export interface FakeClaudeModel extends Model {
  readonly calls: { readonly kind: "generate" | "stream" | "bind"; readonly arg: unknown }[];
}

export function fakeClaudeModel(
  overrides: {
    providerId?: string;
    modelId?: string;
    reasoningLevel?: string;
    displayName?: string;
  } = {},
  calls: FakeClaudeModel["calls"] = [],
): FakeClaudeModel {
  const model = {
    providerId: overrides.providerId ?? CLAUDE_UNIT.providerId,
    modelId: overrides.modelId ?? CLAUDE_UNIT.modelId,
    ...(overrides.displayName ? { displayName: overrides.displayName } : {}),
    properties: { contextWindow: 200_000 },
    optionSpecs: { maxOutputTokens: { max: 64_000 } },
    options: { reasoningLevel: overrides.reasoningLevel ?? "low" },
    calls,
    bind(options?: unknown) {
      calls.push({ kind: "bind", arg: options });
      return fakeClaudeModel(
        {
          ...overrides,
          reasoningLevel:
            (options as { reasoningLevel?: string } | undefined)?.reasoningLevel ??
            overrides.reasoningLevel,
        },
        calls,
      );
    },
    async generateText(request: unknown) {
      calls.push({ kind: "generate", arg: request });
      return { text: "generated" };
    },
    streamText(request: unknown) {
      calls.push({ kind: "stream", arg: request });
      return (async function* () {
        yield { type: "text_delta", text: "streamed" };
      })();
    },
  };
  return model as unknown as FakeClaudeModel;
}

export interface ClaudeUnitRuntime {
  readonly runtime: ClaudeSessionRuntime;
  readonly events: AgentEvent[];
  readonly revoked: string[];
  readonly calls: string[];
}

/** Real ClaudeRuntimeEventSink (schema-validated emit) over stub process / hook server / gateway. */
export function claudeUnitRuntime(
  options: {
    readonly hookCloseError?: Error;
    readonly terminateDelayMs?: number;
  } = {},
): ClaudeUnitRuntime {
  const events: AgentEvent[] = [];
  const revoked: string[] = [];
  const calls: string[] = [];
  const subscriptions = new Map<string, Set<(event: AgentEvent) => void>>([
    [CLAUDE_UNIT.hostSessionId, new Set([(event: AgentEvent) => events.push(event)])],
  ]);
  const sink = new ClaudeRuntimeEventSink(subscriptions);
  const spec = claudeUnitSpec();
  const binding: BackendBinding = {
    hostSessionId: spec.hostSessionId,
    backendSessionId: CLAUDE_UNIT.backendSessionId,
    backendVersion: CLAUDE_UNIT.adapterVersion,
    runtimeEpoch: CLAUDE_UNIT.runtimeEpoch,
  };
  const gateway = {
    revoke: (grantId: string) => {
      revoked.push(grantId);
    },
  } as unknown as ModelGateway;
  const hookServer = {
    close: async () => {
      calls.push("hook.close");
      if (options.hookCloseError) throw options.hookCloseError;
    },
  } as unknown as ClaudeApprovalHookServer;
  const process = {
    isRunning: true,
    terminate: async () => {
      calls.push("process.terminate");
      if (options.terminateDelayMs)
        await new Promise((resolve) => setTimeout(resolve, options.terminateDelayMs));
      calls.push("process.terminated");
    },
    abort: async () => {
      calls.push("process.abort");
    },
  } as unknown as ClaudeStreamProcess;
  const runtime = sink.createRuntime({
    spec,
    plan: claudeUnitPlan(spec),
    binding,
    model: fakeClaudeModel(),
    gateway,
    grant: { id: "grant-claude-unit" } as unknown as ModelGatewayGrant,
    profile: {} as ClaudeSessionProfile,
    process,
    hookServer,
    sequence: 0,
  });
  return { runtime, events, revoked, calls };
}

export function claudeUnitTurn(
  runtime: ClaudeSessionRuntime,
  turnId = "turn-unit",
  started = true,
): ClaudeActiveTurn {
  const turn: ClaudeActiveTurn = {
    hostTurnId: turnId,
    completion: createClaudeTurnCompletion(),
    seenToolIds: new Set(),
    requestedToolIds: new Set(),
    approvedToolIds: new Set(),
    started,
  };
  // Mirrors ClaudeTurnLifecycle.send (claudeTurnLifecycle.ts:110): the rejection is observed later.
  void turn.completion.promise.catch(() => undefined);
  runtime.activeTurn = turn;
  return turn;
}

/** Adds a pending approval so tests can observe denyPendingClaudeApprovals. */
export function claudeUnitPendingApproval(runtime: ClaudeSessionRuntime, turnId: string) {
  const decision = createClaudeDecision();
  runtime.pendingApprovals.set("tool-native-1", {
    nativeToolUseId: "tool-native-1",
    interactionId: "interaction-1",
    toolCallId: "tool-host-1",
    hostTurnId: turnId,
    runtimeEpoch: runtime.binding.runtimeEpoch,
    decision: decision.promise,
    decide: decision.decide,
    state: "pending",
  });
  return decision.promise;
}

export function eventKinds(events: readonly AgentEvent[]): string[] {
  return events.map((event) =>
    event.kind === "session.error"
      ? `session.error:${event.code}`
      : event.kind === "turn.finished"
        ? `turn.finished:${event.outcome}`
        : event.kind,
  );
}
