import type { Worker } from "node:worker_threads";
import type { Model } from "@zcode/contracts";
import type { CapturedHostModel } from "../../agent-host/modelBinding.js";
import type { PiWorkerBoot, ToPiWorker } from "./piProtocol.js";

export type ModelCapture = Model | CapturedHostModel;

export function resolvedCapture(capture: ModelCapture): {
  model: Model;
  identity?: CapturedHostModel["identity"];
} {
  const model = "model" in capture ? capture.model : capture;
  const identity = "model" in capture ? capture.identity : undefined;
  if (
    identity &&
    (identity.providerId !== model.providerId ||
      identity.modelId !== model.modelId ||
      !identity.apiType ||
      !/^[a-f0-9]{64}$/.test(identity.endpointFingerprint))
  )
    throw new Error("Pi frozen model route identity mismatch");
  return { model, ...(identity ? { identity } : {}) };
}

export function piModelInfo(
  model: Model,
  identity?: CapturedHostModel["identity"],
): PiWorkerBoot["model"] {
  return {
    providerId: model.providerId,
    modelId: model.modelId,
    ...(identity ? { identity } : {}),
    ...(model.displayName ? { displayName: model.displayName } : {}),
    properties: { contextWindow: model.properties.contextWindow },
    optionSpecs: { maxOutputTokens: { max: model.optionSpecs.maxOutputTokens.max } },
    options: { reasoningLevel: model.options.reasoningLevel ?? "off" },
  };
}

/** IPC forwarding uses the session owner's frozen per-turn executor, never a live catalog lookup. */
export async function forwardPiModelRequest(
  runtime: {
    worker: Worker;
    binding: { runtimeEpoch: string };
    prepared?: { turnId: string; epoch: string; model: Model };
    modelAborts: Map<string, AbortController>;
    failed?: Error;
  },
  requestId: string,
  turnId: string,
  request: Omit<Parameters<Model["streamText"]>[0], "abortSignal">,
): Promise<void> {
  if (runtime.failed || runtime.modelAborts.has(requestId)) return;
  const model =
    runtime.prepared?.turnId === turnId && runtime.prepared.epoch === runtime.binding.runtimeEpoch
      ? runtime.prepared.model
      : undefined;
  if (!model) {
    runtime.worker.postMessage({ type: "model.failure", requestId } satisfies ToPiWorker);
    return;
  }
  const controller = new AbortController();
  runtime.modelAborts.set(requestId, controller);
  try {
    for await (const event of model.streamText({ ...request, abortSignal: controller.signal })) {
      runtime.worker.postMessage({ type: "model.event", requestId, event } satisfies ToPiWorker);
    }
    if (!runtime.failed)
      runtime.worker.postMessage({ type: "model.done", requestId } satisfies ToPiWorker);
  } catch {
    if (!runtime.failed)
      runtime.worker.postMessage({ type: "model.failure", requestId } satisfies ToPiWorker);
  } finally {
    runtime.modelAborts.delete(requestId);
  }
}
