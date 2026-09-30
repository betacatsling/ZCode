import type { Model } from "@zcode/contracts";
import type { Worker } from "node:worker_threads";
import type { PiModelFailure, ToPiWorker } from "./piProtocol.js";

export interface PiModelRuntimePort {
  readonly worker: Worker;
  readonly model: Model;
  readonly modelAborts: Map<string, AbortController>;
  failed?: Error;
  activeModel?: Model;
}

/** Executes one existing Pi worker request through the Host's admitted turn Model. */
export async function runPiModelRequest(
  runtime: PiModelRuntimePort,
  requestId: string,
  request: Omit<Parameters<Model["streamText"]>[0], "abortSignal">,
): Promise<void> {
  if (runtime.failed || runtime.modelAborts.has(requestId)) return;
  const controller = new AbortController();
  runtime.modelAborts.set(requestId, controller);
  try {
    for await (const event of (runtime.activeModel ?? runtime.model).streamText({
      ...request,
      abortSignal: controller.signal,
    })) {
      runtime.worker.postMessage({ type: "model.event", requestId, event } satisfies ToPiWorker);
    }
    runtime.worker.postMessage({ type: "model.done", requestId } satisfies ToPiWorker);
  } catch (error) {
    const failure = classifyPiModelFailure(error, runtime.activeModel ?? runtime.model);
    runtime.worker.postMessage({
      type: "model.failure",
      requestId,
      ...(failure ? { failure } : {}),
    } satisfies ToPiWorker);
  } finally {
    runtime.modelAborts.delete(requestId);
  }
}

const SAFE_TOKEN = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * Copies only whitelisted scalar fields from the executor's typed error (AiSdkModelAdapterError
 * code + runner context). Messages, causes, headers and URLs never cross into the worker.
 * Provider/model identity comes from the admitted turn Model, not from the error.
 */
function classifyPiModelFailure(error: unknown, model: Model): PiModelFailure | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, context } = error as { code?: unknown; context?: unknown };
  if (!context || typeof context !== "object") return undefined;
  const { reason, statusCode, retryable } = context as Record<string, unknown>;
  if (typeof reason !== "string" || !SAFE_TOKEN.test(reason)) return undefined;
  return {
    reason,
    ...(typeof code === "string" && SAFE_TOKEN.test(code) ? { code } : {}),
    providerId: model.providerId,
    modelId: model.modelId,
    ...(typeof statusCode === "number" && Number.isInteger(statusCode) ? { statusCode } : {}),
    retryable: retryable === true,
  };
}
