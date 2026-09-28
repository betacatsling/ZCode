import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { Model } from "@zcode/contracts";
import {
  backendBindingSchema,
  type BackendBinding,
  type BindingPlan,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { ModelGateway, ModelGatewayGrant } from "@zcode/services/model-gateway";
import { CodexAppServerProcess, type CodexJsonRpcMessage } from "./codexAppServerProcess.js";
import {
  createCodexChildEnvironment,
  prepareCodexSessionProfile,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./codexProfile.js";
import type { CodexSessionRuntime } from "./codexRuntime.js";

export interface CodexSessionLaunchOptions {
  readonly root: string;
  readonly executablePath: string;
  readonly spec: SessionSpec;
  readonly plan: BindingPlan;
  readonly priorBinding?: BackendBinding;
  readonly sequence: number;
  readonly sandboxMode: CodexSandboxMode;
  readonly approvalPolicy: CodexApprovalPolicy;
  readonly model: Model;
  readonly gateway: ModelGateway;
  readonly grant: ModelGatewayGrant;
  readonly onProcess?: (hostSessionId: string, process: CodexAppServerProcess) => void;
  readonly onNotification: (runtime: CodexSessionRuntime, method: string, params: unknown) => void;
  readonly onServerRequest: (
    runtime: CodexSessionRuntime,
    message: CodexJsonRpcMessage,
  ) => Promise<void>;
  readonly onFailure: (runtime: CodexSessionRuntime, error: Error) => void;
  readonly onStderr?: (hostSessionId: string, chunk: string) => void;
  readonly createRuntime: (
    binding: BackendBinding,
    process: CodexAppServerProcess,
    threadId: string,
    context: { model: Model; gateway: ModelGateway; grant: ModelGatewayGrant },
  ) => CodexSessionRuntime;
}

export async function launchCodexSession(
  options: CodexSessionLaunchOptions,
): Promise<CodexSessionRuntime> {
  const profile = await prepareCodexSessionProfile({
    root: options.root,
    spec: options.spec,
    gatewayBaseUrl: options.grant.baseUrl,
    sandboxMode: options.sandboxMode,
    approvalPolicy: options.approvalPolicy,
    shellPath: process.env.PATH ?? dirname(options.executablePath),
  });
  if (!(await stat(profile.cwd)).isDirectory())
    throw new Error("Codex workspace is not a directory");

  let runtime: CodexSessionRuntime | undefined;
  let connection: CodexAppServerProcess | undefined;
  try {
    connection = await CodexAppServerProcess.launch({
      executablePath: options.executablePath,
      cwd: profile.cwd,
      env: createCodexChildEnvironment({
        executablePath: options.executablePath,
        profile,
        gatewayToken: options.grant.token,
      }),
      onNotification: (method, params) => {
        if (runtime) options.onNotification(runtime, method, params);
      },
      onServerRequest: async (message) => {
        if (runtime && connection) {
          await options.onServerRequest(runtime, message);
        } else if (connection && isJsonRpcId(message.id)) {
          await connection.rejectServerRequest(message.id, -32603, "Codex session is not ready");
        }
      },
      onFailure: (error) => {
        if (runtime) options.onFailure(runtime, error);
      },
      ...(options.onStderr
        ? { onStderr: (chunk: string) => options.onStderr!(options.spec.hostSessionId, chunk) }
        : {}),
    });
    options.onProcess?.(options.spec.hostSessionId, connection);
    await connection.request("initialize", {
      clientInfo: {
        name: "zcode-codex-adapter",
        title: "ZCode Codex HarnessAdapter",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    await connection.notify("initialized", {});

    let threadId: string;
    let binding: BackendBinding;
    if (options.priorBinding) {
      threadId = options.priorBinding.backendSessionId;
      binding = options.priorBinding;
      runtime = options.createRuntime(binding, connection, threadId, {
        model: options.model,
        gateway: options.gateway,
        grant: options.grant,
      });
      const resumed = await connection.request("thread/resume", {
        threadId,
        model: "zcode-host",
        modelProvider: "zcode",
        cwd: profile.cwd,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandboxMode,
      });
      if (!threadMatches(resumed, threadId))
        throw new Error("Codex resumed a different native thread");
    } else {
      const started = await connection.request("thread/start", {
        model: "zcode-host",
        modelProvider: "zcode",
        cwd: profile.cwd,
        approvalPolicy: options.approvalPolicy,
        sandbox: options.sandboxMode,
      });
      threadId = threadIdFrom(started);
      binding = backendBindingSchema.parse({
        hostSessionId: options.spec.hostSessionId,
        backendSessionId: threadId,
        backendVersion: "0.157.1",
        runtimeEpoch: randomUUID(),
      });
      runtime = options.createRuntime(binding, connection, threadId, {
        model: options.model,
        gateway: options.gateway,
        grant: options.grant,
      });
    }
    if (runtime.failed) throw runtime.failed;
    return runtime;
  } catch (error) {
    options.gateway.revoke(options.grant.id);
    if (runtime?.activeTurn) {
      runtime.activeTurn.completion.reject(
        new Error("Codex startup ended before the turn outcome was known"),
      );
    }
    if (connection) await connection.terminate();
    throw error;
  }
}

function threadIdFrom(value: unknown): string {
  if (
    !isRecord(value) ||
    !isRecord(value.thread) ||
    typeof value.thread.id !== "string" ||
    !value.thread.id
  ) {
    throw new Error("Codex thread/start response omitted its opaque thread id");
  }
  return value.thread.id;
}

function threadMatches(value: unknown, expected: string): boolean {
  return isRecord(value) && isRecord(value.thread) && value.thread.id === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is string | number {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}
