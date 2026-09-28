import type { Model } from "@zcode/contracts";
import type { Worker } from "node:worker_threads";
import type { ToPiWorker } from "./piProtocol.js";

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
  } catch {
    runtime.worker.postMessage({ type: "model.failure", requestId } satisfies ToPiWorker);
  } finally {
    runtime.modelAborts.delete(requestId);
  }
}
