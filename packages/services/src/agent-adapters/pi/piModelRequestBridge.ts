import type { Model } from "@zcode/contracts";
import type { Worker } from "node:worker_threads";
import { extractModelFailure } from "../../agent-host/modelFailureClassification.js";
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

/**
 * Pi name for the shared, harness-neutral extraction (see agent-host/modelFailureClassification).
 * Whitelisted scalars only; identity comes from the admitted turn Model.
 */
export function classifyPiModelFailure(error: unknown, model: Model): PiModelFailure | undefined {
  return extractModelFailure(error, model);
}
