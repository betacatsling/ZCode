import type { AgentEvent, BackendBinding } from "@zcode/shared/agent-host";
import type { FromPiWorker, ToPiWorker } from "./piProtocol.js";
import { runPiModelRequest, type PiModelRuntimePort } from "./piModelRequestBridge.js";

export interface PiWorkerRuntimePort extends PiModelRuntimePort {
  readonly binding: BackendBinding;
  lastSequence: number;
  readonly pending: Map<string, { resolve(): void; reject(error: Error): void }>;
}

export function sendPiWorkerCommand(
  runtime: Pick<PiWorkerRuntimePort, "worker" | "pending" | "failed">,
  commandId: string,
  message: ToPiWorker,
): Promise<void> {
  if (runtime.failed) return Promise.reject(runtime.failed);
  if (runtime.pending.has(commandId)) throw new Error("duplicate Pi command correlation ID");
  return new Promise((resolve, reject) => {
    runtime.pending.set(commandId, { resolve, reject });
    runtime.worker.postMessage(message);
  });
}

export function routePiWorkerMessage<R extends PiWorkerRuntimePort>(input: {
  readonly hostSessionId: string;
  readonly runtime: R;
  readonly message: FromPiWorker;
  readonly publishEvent: (event: AgentEvent) => void;
  readonly fail: (runtime: R, error: Error) => void;
}): void {
  const { hostSessionId, runtime, message } = input;
  if (message.type === "event") {
    const event = message.event;
    if (
      event.hostSessionId !== hostSessionId ||
      event.runtimeEpoch !== runtime.binding.runtimeEpoch ||
      event.sequence !== runtime.lastSequence + 1
    ) {
      input.fail(runtime, new Error("Pi worker event sequence or identity mismatch"));
      return;
    }
    runtime.lastSequence = event.sequence;
    input.publishEvent(event);
  } else if (message.type === "ack") {
    const pending = runtime.pending.get(message.commandId);
    if (!pending) return;
    runtime.pending.delete(message.commandId);
    if (message.outcome === "completed") pending.resolve();
    else pending.reject(new Error("Pi operation failed"));
  } else if (message.type === "model.request") {
    void runPiModelRequest(runtime, message.requestId, message.request);
  } else if (message.type === "model.abort") {
    runtime.modelAborts.get(message.requestId)?.abort();
  } else if (message.type === "fatal") {
    input.fail(runtime, new Error(message.message));
  }
}

export function failPiWorkerRuntime(
  runtime: PiModelRuntimePort & {
    readonly pending: Map<string, { resolve(): void; reject(error: Error): void }>;
  },
  error: Error,
): void {
  if (runtime.failed) return;
  runtime.failed = error;
  for (const controller of runtime.modelAborts.values()) controller.abort();
  runtime.modelAborts.clear();
  for (const pending of runtime.pending.values()) pending.reject(error);
  runtime.pending.clear();
}
