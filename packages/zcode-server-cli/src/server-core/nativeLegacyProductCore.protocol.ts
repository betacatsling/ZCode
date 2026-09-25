import assert from "node:assert/strict";

export async function recordWorkerPid(
  agent: any,
  scope: WorkspaceScope,
  pids: Set<number>,
): Promise<void> {
  const identity = await agent.getWorkspaceRuntimeIdentity(scope);
  if (Number.isSafeInteger(identity.processId) && identity.processId > 0)
    pids.add(identity.processId);
}

export interface WorkspaceScope {
  targetId: string;
  workspacePath: string;
  workspaceIdentity: string;
}

export async function subscribeConversation(
  agent: any,
  scope: WorkspaceScope,
  sessionId: string,
): Promise<string> {
  const result = await agent.subscribeConversationV4({ ...scope, sessionId });
  const subscriptionId = result?.ack?.subscriptionId;
  assert.equal(typeof subscriptionId, "string");
  return subscriptionId;
}

export async function sendText(
  agent: any,
  scope: WorkspaceScope,
  sessionId: string,
  commandId: string,
  text: string,
) {
  return await agent.sendConversationCommandV4({
    ...scope,
    envelope: {
      commandId,
      clientId: "native-legacy-core-client",
      sessionId,
      type: "sendText",
      issuedAt: Date.now(),
      payload: { text, requestedDelivery: "startNow" },
    },
  });
}

export function waitForTerminal(
  agent: any,
  scope: WorkspaceScope,
  sessionId: string,
  commandId: string,
): Promise<void> {
  return waitForFrame(agent, scope, (wire) => {
    if (wire.topic !== `conversation/${sessionId}`) return false;
    return terminalRows(wire).some(
      (row) => row.sourceCommandId === commandId && row.state === "completedSuccess",
    );
  });
}

export function waitForAnyTerminal(
  agent: any,
  scope: WorkspaceScope,
  commandId: string,
): Promise<void> {
  return waitForFrame(agent, scope, (wire) =>
    terminalRows(wire).some(
      (row) => row.sourceCommandId === commandId && row.state === "completedSuccess",
    ),
  );
}

function waitForFrame(
  agent: any,
  scope: WorkspaceScope,
  predicate: (wire: any) => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const disposable = agent.onDynamicConversationFrame(scope)((frame: any) => {
      if (!predicate(frame)) return;
      clearTimeout(timer);
      disposable.dispose();
      resolve();
    });
    timer = setTimeout(() => {
      disposable.dispose();
      reject(new Error("real legacy V4 terminal frame timed out"));
    }, 15000);
  });
}

function terminalRows(wire: any): Array<{ sourceCommandId?: string; state?: string }> {
  const frame = wire.frame ?? wire;
  const payload = frame.payload;
  if (!payload) return [];
  const rows =
    payload.kind === "deltas"
      ? (payload.deltas as Array<{ row?: unknown }>).map(({ row }) => row)
      : ((payload.snapshot?.rows?.window as unknown[] | undefined) ?? []);
  return rows.filter(
    (row): row is { kind: string; sourceCommandId?: string; state?: string } =>
      !!row && typeof row === "object" && "kind" in row && row.kind === "turnHeader",
  );
}
