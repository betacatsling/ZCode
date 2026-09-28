import type { Model } from "@zcode/contracts";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { BindingPlan, SessionSpec } from "@zcode/shared/agent-host";
import type { ModelGateway } from "@zcode/services/model-gateway";
import type { CodexAppServerProcess } from "./codexAppServerProcess.js";
import {
  resolveCodexExecutable,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./codexProfile.js";
import {
  assertCodexGrantMatchesBinding,
  guardCodexModel,
  reasoningIsDisabled,
  validateCodexBinding,
} from "./codexBinding.js";
import type { CodexSessionRuntime } from "./codexRuntime.js";
import { launchCodexSession, type CodexSessionLaunchOptions } from "./codexSessionLauncher.js";
import { translateCodexNotification } from "./codexEventTranslator.js";
import { handleCodexServerRequest } from "./codexApprovalProtocol.js";
import type { CodexRuntimeEvents } from "./codexRuntimeEvents.js";
import { CODEX_GRANT_LIFETIME_MS } from "./codexTargetGateway.js";

type LaunchPorts = Pick<
  CodexSessionLaunchOptions,
  "createRuntime" | "onNotification" | "onServerRequest" | "onFailure"
> &
  Pick<CodexSessionLaunchOptions, "onProcess" | "onStderr">;

export interface CodexSessionFactoryOptions extends LaunchPorts {
  readonly root: string;
  readonly executablePath?: string;
  readonly spec: SessionSpec;
  readonly plan: BindingPlan;
  readonly priorBinding?: CodexSessionRuntime["binding"];
  readonly sequence: number;
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly hostManagedRoute: BindingPlan["route"];
  readonly modelFactory: (spec: SessionSpec, plan: BindingPlan) => Promise<Model> | Model;
  readonly preparedModel?: Model;
  readonly isOpenAiResponsesSelection: (selection: ModelSelection) => boolean;
  readonly isSelectionAuthorized: (plan: BindingPlan) => boolean;
  readonly getGateway: (targetId: string) => Promise<ModelGateway> | ModelGateway;
  readonly sandboxMode: CodexSandboxMode;
  readonly approvalPolicy: CodexApprovalPolicy;
}

export interface CodexHarnessSessionOptions extends Omit<
  CodexSessionFactoryOptions,
  keyof LaunchPorts
> {
  readonly events: CodexRuntimeEvents;
  readonly onProcess?: (hostSessionId: string, process: CodexAppServerProcess) => void;
  readonly onStderr?: (hostSessionId: string, chunk: string) => void;
}

export function createCodexHarnessSession(
  options: CodexHarnessSessionOptions,
): Promise<CodexSessionRuntime> {
  const { events, onProcess, onStderr, ...sessionOptions } = options;
  return createCodexSession({
    ...sessionOptions,
    ...(onProcess ? { onProcess } : {}),
    ...(onStderr ? { onStderr } : {}),
    createRuntime: (binding, process, threadId, context) =>
      events.createRuntime({
        spec: options.spec,
        plan: options.plan,
        binding,
        ...context,
        process,
        threadId,
        sequence: options.sequence,
      }),
    onNotification: (runtime, method, params) =>
      translateCodexNotification(runtime, method, params, (turn, status, hasError) =>
        events.completeTurn(runtime, turn, status, hasError),
      ),
    onServerRequest: handleCodexServerRequest,
    onFailure: (runtime, error) => events.fail(runtime, error),
  });
}

export async function createCodexSession(
  options: CodexSessionFactoryOptions,
): Promise<CodexSessionRuntime> {
  validateCodexBinding({
    shuttingDown: false,
    spec: options.spec,
    plan: options.plan,
    adapterId: options.adapterId,
    adapterVersion: options.adapterVersion,
    hostManagedRoute: options.hostManagedRoute,
    supportsOpenAiResponses: options.isOpenAiResponsesSelection,
  });
  const executablePath = await resolveCodexExecutable(options.executablePath);
  const model = options.preparedModel ?? (await options.modelFactory(options.spec, options.plan));
  if (
    !options.plan.effective ||
    model.providerId !== options.plan.effective.providerId ||
    model.modelId !== options.plan.effective.modelId ||
    !reasoningIsDisabled(model.options.reasoningLevel)
  ) {
    throw new Error("Codex Model binding differs from the admitted OpenAI Responses selection");
  }
  if (!options.isSelectionAuthorized(options.plan))
    throw new Error("Codex model selection is no longer authorized");
  const guardedModel = guardCodexModel(model, options.plan, options.isSelectionAuthorized);
  const gateway = await options.getGateway(options.plan.targetId);
  await gateway.start();
  if (!options.isSelectionAuthorized(options.plan))
    throw new Error("Codex model selection is no longer authorized");
  const grant = gateway.createGrant({
    protocol: "openai-responses",
    sessionId: options.spec.hostSessionId,
    modelBindingFingerprint: options.plan.catalogFingerprint,
    publicModelId: "zcode-host",
    model: guardedModel,
    expiresInMs: CODEX_GRANT_LIFETIME_MS,
    limits: {
      maxBodyBytes: 1024 * 1024,
      maxRequests: 2_000,
      maxConcurrent: 2,
      maxOutputTokens: 1_000_000,
      maxOutputTokensPerRequest: 32_000,
    },
  });
  try {
    if (!options.isSelectionAuthorized(options.plan))
      throw new Error("Codex model selection is no longer authorized");
    assertCodexGrantMatchesBinding(grant, options.spec, options.plan, guardedModel);
    const runtime = await launchCodexSession({
      root: options.root,
      executablePath,
      spec: options.spec,
      plan: options.plan,
      ...(options.priorBinding ? { priorBinding: options.priorBinding } : {}),
      sequence: options.sequence,
      sandboxMode: options.sandboxMode,
      approvalPolicy: options.approvalPolicy,
      model: guardedModel,
      gateway,
      grant,
      ...(options.onProcess ? { onProcess: options.onProcess } : {}),
      ...(options.onStderr ? { onStderr: options.onStderr } : {}),
      createRuntime: options.createRuntime,
      onNotification: options.onNotification,
      onServerRequest: options.onServerRequest,
      onFailure: options.onFailure,
    });
    if (!options.isSelectionAuthorized(options.plan)) {
      runtime.failed = new Error("Codex model selection was revoked during app-server startup");
      gateway.revoke(grant.id);
      await runtime.process.terminate();
      throw runtime.failed;
    }
    return runtime;
  } catch (error) {
    gateway.revoke(grant.id);
    throw error;
  }
}
