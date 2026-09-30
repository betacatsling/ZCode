import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import type { AgentEvent } from "@zcode/shared/agent-host";
import type { Model, ModelRequest, ModelStreamEvent } from "@zcode/contracts";
import type { FromPiWorker, PiModelFailure, PiWorkerBoot } from "./piProtocol.js";

/**
 * Pi worker runtime moved verbatim out of piWorker.ts: boot data, parent port, the host
 * event/ack channel, the host-model proxy stream and the worktree path gate.
 * Loaded by piWorker.ts with the source/bundle-aware dynamic import (see there); it must keep
 * only package or type-only static imports, because source-mode workers cannot resolve
 * relative `.js` specifiers to `.ts` files.
 */
export const boot = workerData as PiWorkerBoot;
if (!parentPort) throw new Error("Pi worker must have a parent host");
export const port = parentPort;
let sequence = boot.sequence;
export const modelStreams = new Map<
  string,
  {
    values: ModelStreamEvent[];
    waiting?: () => void;
    done: boolean;
    failed: boolean;
    failure?: PiModelFailure;
  }
>();

export function post(value: FromPiWorker): void {
  port.postMessage(value);
}
export function emit(kind: AgentEvent["kind"], payload: Record<string, unknown>): void {
  const event = {
    hostSessionId: boot.spec.hostSessionId,
    runtimeEpoch: boot.binding.runtimeEpoch,
    sequence: ++sequence,
    eventId: randomUUID(),
    at: Date.now(),
    kind,
    ...payload,
  } as AgentEvent;
  post({ type: "event", event });
}
export function reply(commandId: string, outcome: "completed" | "failed"): void {
  post({ type: "ack", commandId, outcome });
}

export function modelProxy(): Model {
  return {
    ...boot.model,
    async *streamText(request: ModelRequest) {
      const requestId = randomUUID();
      const state = {
        values: [] as ModelStreamEvent[],
        waiting: undefined as (() => void) | undefined,
        done: false,
        failed: false,
        failure: undefined as PiModelFailure | undefined,
      };
      modelStreams.set(requestId, state);
      const onAbort = () => post({ type: "model.abort", requestId });
      request.abortSignal?.addEventListener("abort", onAbort, { once: true });
      if (request.abortSignal?.aborted) onAbort();
      try {
        const { abortSignal: _signal, ...serializable } = request;
        post({ type: "model.request", requestId, request: serializable });
        while (!state.done || state.values.length) {
          if (!state.values.length) {
            await new Promise<void>((wake) => {
              state.waiting = wake;
            });
            continue;
          }
          yield state.values.shift()!;
        }
        if (state.failed)
          throw Object.assign(
            new Error("ZCode model executor failed"),
            state.failure ? { zcodeModelFailure: state.failure } : {},
          );
      } finally {
        request.abortSignal?.removeEventListener("abort", onAbort);
        modelStreams.delete(requestId);
      }
    },
  } as unknown as Model;
}

export async function pathWithinWorkspace(raw: unknown, allowMissing: boolean): Promise<boolean> {
  if (typeof raw !== "string" || !raw || raw.includes("\0")) return false;
  const root = await realpath(boot.spec.execution.worktreePath);
  const path = isAbsolute(raw) ? resolve(raw) : resolve(root, raw);
  const resolved = await realpath(path).catch(async () =>
    allowMissing ? resolve(await realpath(dirname(path)), path.split("/").at(-1)!) : "",
  );
  const rel = relative(root, resolved);
  return !!resolved && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
}
