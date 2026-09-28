import { sessionSpecSchema, type SessionSpec } from "@zcode/shared/agent-host";
import { runUnderOwnerFence } from "./ownerFence.js";

type OwnerGate = Parameters<typeof runUnderOwnerFence>[0];

/** 同一 hostSessionId 的 create/attach 串行；失败不丢掉后续排队操作。 */
export function enqueueAdmission<T>(
  tails: Map<string, Promise<void>>,
  hostSessionId: string,
  isClosing: () => boolean,
  operation: () => Promise<T>,
): Promise<T> {
  if (isClosing()) throw new Error("target host is closing");
  const previous = tails.get(hostSessionId);
  const runOperation = async (): Promise<T> => {
    if (isClosing()) throw new Error("target host is closing");
    return operation();
  };
  const run = previous ? previous.then(runOperation, runOperation) : runOperation();
  const settled = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(hostSessionId, settled);
  void settled.then(() => {
    if (tails.get(hostSessionId) === settled) tails.delete(hostSessionId);
  });
  return run;
}

export function admitOwnedSession<T>(input: {
  raw: SessionSpec;
  tails: Map<string, Promise<void>>;
  isClosing: () => boolean;
  owner: OwnerGate;
  isMounted: (hostSessionId: string) => boolean;
  operation: (spec: SessionSpec) => Promise<T>;
}): Promise<T> {
  const spec = sessionSpecSchema.parse(input.raw);
  // 修复依据：#verify 含 realpath/授权 await；owner 预留必须和 mount 落在同一 lane，避免第二个 create 越过检查。
  return enqueueAdmission(input.tails, spec.hostSessionId, input.isClosing, () =>
    runUnderOwnerFence(
      input.owner,
      spec.hostSessionId,
      () => input.isMounted(spec.hostSessionId),
      () => input.operation(spec),
    ),
  );
}
