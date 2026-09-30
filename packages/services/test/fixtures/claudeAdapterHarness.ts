import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type test from "node:test";
import type { AgentEvent, BindingPlan, SessionSpec } from "@zcode/shared/agent-host";
import type { PreparedHostBinding } from "../../src/agent-host/harnessRegistry.js";
import { TargetModelGateway } from "../../src/model-gateway/index.js";
import {
  ClaudeHarnessAdapter,
  type ClaudeHarnessAdapterOptions,
} from "../../src/agent-adapters/claude/claudeHarnessAdapter.js";
import type { ClaudeStreamProcess } from "../../src/agent-adapters/claude/claudeStreamProcess.js";
import { fakeClaudeLauncher, type FakeClaudeProcessBehavior } from "./claudeFakeProcess.js";
import {
  CLAUDE_UNIT,
  claudeUnitPlan,
  claudeUnitSpec,
  fakeClaudeModel,
} from "./claudeUnitFixtures.js";

// ClaudeHarnessAdapter over the launchProcess hook: real Gateway, hook server and profile files,
// injected fake process. Grant creation / revocation is recorded on the target Gateway instance.

export interface ClaudeAdapterHarnessOptions {
  readonly behavior?: FakeClaudeProcessBehavior;
  readonly adapter?: Partial<ClaudeHarnessAdapterOptions>;
}

export async function claudeAdapterHarness(
  t: test.TestContext,
  options: ClaudeAdapterHarnessOptions = {},
) {
  const root = await mkdtemp(join(tmpdir(), "zcode-claude-hook-"));
  const targetModelGateway = new TargetModelGateway();
  const { launchProcess, launches } = fakeClaudeLauncher(options.behavior);
  const workspace = join(root, "workspace");
  await mkdir(workspace, { mode: 0o700 });
  const unitSpec = claudeUnitSpec();
  const spec: SessionSpec = {
    ...unitSpec,
    execution: { ...unitSpec.execution, worktreePath: workspace },
  };
  const plan = claudeUnitPlan(spec);
  const events: AgentEvent[] = [];
  const onProcess: { hostSessionId: string; process: ClaudeStreamProcess }[] = [];
  const adapter = new ClaudeHarnessAdapter({
    root,
    executablePath: join(root, "missing-claude"),
    targetModelGateway,
    modelFactory: () => fakeClaudeModel(),
    isMessagesSelection: () => true,
    fakeModelCompatibilityEvidence: (selection) => ({
      providerId: selection.providerId,
      modelId: selection.modelId,
      fixtureId: CLAUDE_UNIT.fixtureId,
    }),
    launchProcess,
    onProcess: (hostSessionId, process) => onProcess.push({ hostSessionId, process }),
    ...options.adapter,
  });
  adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
  const gateway = targetModelGateway.get(spec.execution.targetId);
  const grants = { created: [] as string[], revoked: [] as string[] };
  const createGrant = gateway.createGrant.bind(gateway);
  const revoke = gateway.revoke.bind(gateway);
  gateway.createGrant = (input) => {
    const grant = createGrant(input);
    grants.created.push(grant.id);
    return grant;
  };
  gateway.revoke = (grantId) => {
    grants.revoked.push(grantId);
    revoke(grantId);
  };
  t.after(async () => {
    await adapter.shutdown();
    await targetModelGateway.close();
    await rm(root, { recursive: true, force: true });
  });
  return { adapter, root, spec, plan, launches, events, grants, onProcess, targetModelGateway };
}

export type ClaudeAdapterHarness = Awaited<ReturnType<typeof claudeAdapterHarness>>;

export function preparedTurn(plan: BindingPlan, turnId: string): PreparedHostBinding {
  return { plan, model: fakeClaudeModel(), turnId };
}

export function sendCommand(spec: SessionSpec, turnId: string, text = `run ${turnId}`) {
  return {
    type: "send" as const,
    commandId: `send-${turnId}`,
    hostSessionId: spec.hostSessionId,
    turnId,
    text,
  };
}

/** prepareTurn + send; returns the pending send so callers can observe its settlement. */
export async function startTurn(
  h: ClaudeAdapterHarness,
  turnId: string,
  plan: BindingPlan = h.plan,
): Promise<{ readonly sending: Promise<void> }> {
  const prepared = preparedTurn(plan, turnId);
  await h.adapter.prepareTurn(h.spec, prepared);
  const sending = h.adapter.send(sendCommand(h.spec, turnId), prepared);
  void sending.catch(() => undefined);
  return { sending };
}

/** Number of listening TCP servers in this process (Gateway + hook servers). */
export function listeningServers(): number {
  return process.getActiveResourcesInfo().filter((kind) => kind === "TCPServerWrap").length;
}

export function eventsOf<K extends AgentEvent["kind"]>(
  events: readonly AgentEvent[],
  kind: K,
): Extract<AgentEvent, { kind: K }>[] {
  return events.filter((event): event is Extract<AgentEvent, { kind: K }> => event.kind === kind);
}
