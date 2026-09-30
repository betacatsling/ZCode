import { randomUUID } from "node:crypto";
import type { Model } from "@zcode/contracts";
import type { BackendBinding, BindingPlan, SessionSpec } from "@zcode/shared/agent-host";
import type { TargetModelGateway } from "@zcode/services/model-gateway";
import type { PreparedHostBinding } from "../../agent-host/harnessRegistry.js";
import { ClaudeApprovalHookServer } from "./claudeApprovalHookServer.js";
import { guardClaudeModel, validateClaudeModel } from "./claudeBindingGuards.js";
import { readClaudeCliVersion, resolveClaudeExecutable } from "./claudeExecutable.js";
import {
  createClaudeArguments,
  createClaudeChildEnvironment,
  prepareClaudeSessionProfile,
} from "./claudeProfile.js";
import { requestClaudeApproval } from "./claudeHostApproval.js";
import type { ClaudeSessionRegistry } from "./claudeSessionRegistry.js";
import type { ClaudeRuntimeEventSink } from "./claudeRuntimeEventSink.js";
import type { ClaudeSessionRuntime } from "./claudeRuntime.js";
import { ClaudeStreamProcess, type ClaudeStructuredMessage } from "./claudeStreamProcess.js";
import {
  failClaudeRuntime,
  stopClaudeRuntime,
  translateClaudeRuntimeMessage,
} from "./claudeRuntimeOutcome.js";

// Session startup / idle rebind for ClaudeHarnessAdapter (moved verbatim from the adapter class).

/** Public Messages alias must be a Claude Code–recognized model id; the grant still binds the Host Model. */
export const CLAUDE_PUBLIC_MODEL_ID = "claude-sonnet-4-6";
const CLAUDE_TOOL_ALLOWLIST = ["Bash", "Edit", "Read", "Write", "Glob", "Grep"] as const;
const CLAUDE_MAX_OUTPUT_TOKENS = 32_000;

export type ClaudeProcessLaunchOptions = ConstructorParameters<typeof ClaudeStreamProcess>[0];
/** Test seam shaped like Codex `launchAppServer`; unset keeps executable discovery and spawn. */
export type ClaudeProcessLauncher = (
  options: ClaudeProcessLaunchOptions,
) => Promise<ClaudeStreamProcess>;

/** Adapter state read by the startup path; built once by ClaudeHarnessAdapter. */
export interface ClaudeSessionStartupContext {
  readonly version: string;
  readonly root: string;
  readonly executablePath: string | undefined;
  readonly modelFactory: (spec: SessionSpec, plan: BindingPlan) => Promise<Model> | Model;
  readonly isSelectionAuthorized: (plan: BindingPlan) => boolean;
  readonly targetGateway: TargetModelGateway;
  readonly eventSink: ClaudeRuntimeEventSink;
  readonly registry: ClaudeSessionRegistry;
  readonly onProcess: ((hostSessionId: string, process: ClaudeStreamProcess) => void) | undefined;
  readonly launchProcess: ClaudeProcessLauncher | undefined;
  readonly isShuttingDown: () => boolean;
  readonly validatePlan: (spec: SessionSpec, plan: BindingPlan) => void;
}

export async function startClaudeSession(
  ctx: ClaudeSessionStartupContext,
  spec: SessionSpec,
  plan: BindingPlan,
  priorBinding: BackendBinding | undefined,
  sequence: number,
  prepared?: PreparedHostBinding,
): Promise<ClaudeSessionRuntime> {
  if (prepared && prepared.plan !== plan)
    throw new Error("Claude startup received another prepared plan");
  ctx.validatePlan(spec, plan);
  // An injected launcher owns the process, so there is no executable to discover or version-check.
  const executablePath = ctx.launchProcess
    ? (ctx.executablePath ?? "claude")
    : await resolveClaudeExecutable(ctx.executablePath);
  if (!ctx.launchProcess && (await readClaudeCliVersion(executablePath)) !== ctx.version)
    throw new Error("Claude Code CLI version does not match 2.1.263");
  const model = prepared?.model ?? (await ctx.modelFactory(spec, plan));
  validateClaudeModel(plan, model);
  if (!ctx.isSelectionAuthorized(plan))
    throw new Error("Claude Model selection is no longer authorized");
  const guardedModel = guardClaudeModel(model, plan, ctx.isSelectionAuthorized);
  const gateway = ctx.targetGateway.get(plan.targetId);
  await gateway.start();
  const maxOutputTokens = Math.min(
    model.options.maxOutputTokens ?? model.optionSpecs.maxOutputTokens.max,
    CLAUDE_MAX_OUTPUT_TOKENS,
  );
  const effort = plan.effective?.options?.reasoningLevel;
  if (!effort) throw new Error("Claude Model binding has no selected effort level");
  const grant = gateway.createGrant({
    protocol: "anthropic-messages",
    sessionId: spec.hostSessionId,
    modelBindingFingerprint: plan.catalogFingerprint,
    publicModelId: CLAUDE_PUBLIC_MODEL_ID,
    model: guardedModel,
    expiresInMs: ctx.targetGateway.grantLifetimeMs,
    limits: {
      maxBodyBytes: 1024 * 1024,
      maxRequests: 2_000,
      maxConcurrent: 2,
      maxOutputTokens: 1_000_000,
      maxOutputTokensPerRequest: maxOutputTokens,
    },
  });
  const nativeSessionId = priorBinding?.backendSessionId ?? randomUUID();
  const binding = priorBinding ?? {
    hostSessionId: spec.hostSessionId,
    backendSessionId: nativeSessionId,
    backendVersion: ctx.version,
    runtimeEpoch: randomUUID(),
  };
  if (binding.backendVersion !== ctx.version || binding.hostSessionId !== spec.hostSessionId) {
    gateway.revoke(grant.id);
    throw new Error("Claude backend binding version or owner differs");
  }

  let runtime: ClaudeSessionRuntime | undefined;
  let earlyFailure: Error | undefined;
  const earlyMessages: ClaudeStructuredMessage[] = [];
  const hookServer = new ClaudeApprovalHookServer((input, signal) =>
    runtime ? requestClaudeApproval(runtime, input, signal) : Promise.resolve("deny"),
  );
  let process: ClaudeStreamProcess | undefined;
  try {
    const hookUrl = await hookServer.start();
    const profile = await prepareClaudeSessionProfile({
      root: ctx.root,
      spec,
      gatewayBaseUrl: grant.baseUrl,
      gatewayToken: grant.token,
      hookUrl,
      modelAlias: grant.publicModelId,
      effort,
      maxOutputTokens,
    });
    const launch: ClaudeProcessLaunchOptions = {
      executablePath,
      args: createClaudeArguments({
        executablePath,
        profile,
        nativeSessionId,
        resume: priorBinding !== undefined,
        tools: CLAUDE_TOOL_ALLOWLIST,
      }),
      cwd: profile.cwd,
      env: createClaudeChildEnvironment({ profile, executablePath }),
      onMessage: (message) => {
        if (runtime) translateClaudeRuntimeMessage(runtime, message);
        else earlyMessages.push(message);
      },
      onFailure: (error) => {
        if (runtime) failClaudeRuntime(runtime, error);
        else earlyFailure = error;
      },
    };
    process = ctx.launchProcess ? await ctx.launchProcess(launch) : new ClaudeStreamProcess(launch);
    runtime = ctx.eventSink.createRuntime({
      spec,
      plan,
      binding,
      model: guardedModel,
      gateway,
      grant,
      profile,
      process,
      hookServer,
      sequence,
    });
    ctx.onProcess?.(spec.hostSessionId, process);
    for (const message of earlyMessages) translateClaudeRuntimeMessage(runtime, message);
    if (earlyFailure) failClaudeRuntime(runtime, earlyFailure);
    if (!ctx.isSelectionAuthorized(plan)) {
      runtime.failed = new Error("Claude Model selection was revoked during process startup");
      await stopClaudeRuntime(runtime);
      throw runtime.failed;
    }
    return runtime;
  } catch (error) {
    gateway.revoke(grant.id);
    if (process?.isRunning) await process.terminate();
    await hookServer.close();
    if (runtime) ctx.registry.remove(spec.hostSessionId, runtime);
    throw error;
  }
}

export async function replaceClaudeIdleBinding(
  ctx: ClaudeSessionStartupContext,
  previous: ClaudeSessionRuntime,
  prepared: PreparedHostBinding,
): Promise<ClaudeSessionRuntime> {
  if (previous.activeTurn || previous.preparedTurnId)
    throw new Error("Claude cannot replace its Model binding during an active turn");
  await stopClaudeRuntime(previous);
  ctx.registry.remove(previous.spec.hostSessionId, previous);
  const starting = ctx.registry.reserveStart(previous.spec.hostSessionId, () =>
    startClaudeSession(
      ctx,
      previous.spec,
      prepared.plan,
      previous.binding,
      previous.sequence.value,
      prepared,
    ),
  );
  try {
    const rebound = await starting;
    if (ctx.isShuttingDown()) {
      await stopClaudeRuntime(rebound);
      throw new Error("Claude target host is shutting down");
    }
    ctx.registry.add(previous.spec.hostSessionId, rebound);
    return rebound;
  } catch (error) {
    previous.stopping = false;
    previous.failed = error instanceof Error ? error : new Error("Claude rebind failed");
    ctx.registry.add(previous.spec.hostSessionId, previous);
    throw error;
  } finally {
    ctx.registry.releaseStart(previous.spec.hostSessionId, starting);
  }
}
