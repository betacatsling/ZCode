import assert from "node:assert/strict";
import { waitForTerminal, type WorkspaceScope } from "./nativeLegacyProductCore.protocol.js";

export interface LegacyFixtureResult {
  kind: "result";
  unmappedOwner: null;
  indexedOriginalId: string;
  mappingCount: number;
  joinedOwner: { kind: string; originalSessionId: string; historyOnly: boolean };
  initialCommandStatus: string;
  followupCommandStatus: string;
  followupTerminal: boolean;
  runningCommandStatus: string;
  queuedCommandStatus: string;
  queuedRetryStatus: string;
  reconnectSubscription: boolean;
  sideSessionStatus: string;
  sideSessionId: string;
  sideSessionParentId: string;
  duplicateSideSessionStatus: string;
  forkedId: string;
  forkTarget: { rowId: number; entityId: string };
  forkRevision: number;
  forkColdId: string;
  editTarget: { rowId: number; entityId: string };
  retryTarget: { rowId: number; entityId: string };
  editStatus: string;
  retryStatus: string;
  editedText: string;
  coldVisibleInputs: string[];
  modelCalls: string[];
  modelRequestContainsInput: boolean[];
  workerPids: number[];
  coldOwner: { originalSessionId: string; historyOnly: boolean };
  coldResumeIds: string[];
}

interface Row {
  rowId: number;
  entityId?: string;
  kind: string;
  text?: string;
  origin?: string;
  actions?: { canFork?: boolean; canEdit?: boolean; canRetry?: boolean };
}
interface Snapshot {
  revision: number;
  logEpoch: string;
  rows: { window: Row[] };
}

/** Read an actual public CLI snapshot; never manufacture display row identities from SQLite. */
async function currentSnapshot(agent: any, scope: WorkspaceScope, sessionId: string) {
  let dispose: (() => void) | undefined;
  const snapshotPromise = new Promise<Snapshot>((resolve, reject) => {
    const timer = setTimeout(() => {
      dispose?.();
      reject(new Error(`no V4 snapshot for ${sessionId}`));
    }, 15000);
    const listener = agent.onDynamicConversationFrame(scope)((wire: any) => {
      const frame = wire.frame ?? wire;
      if (frame.topic !== `conversation/${sessionId}` || frame.payload?.kind !== "snapshot") return;
      clearTimeout(timer);
      dispose?.();
      resolve(frame.payload.snapshot as Snapshot);
    });
    dispose = () => listener.dispose();
  });
  try {
    const subscribed = await agent.subscribeConversationV4({ ...scope, sessionId });
    return {
      snapshot: await snapshotPromise,
      subscriptionId: subscribed.ack.subscriptionId as string,
    };
  } catch (error) {
    // Promise listener is bounded even when subscription fails.
    void snapshotPromise.catch(() => {});
    throw error;
  }
}

async function command(
  agent: any,
  scope: WorkspaceScope,
  sessionId: string,
  snapshot: Snapshot,
  row: Row,
  commandId: string,
  type: "forkAssistant" | "editUserQuery" | "retryTurn",
  extra: Record<string, unknown> = {},
  issuedAt = Date.now(),
) {
  assert.ok(row.entityId, `${type} requires a real stable entityId`);
  return agent.sendConversationCommandV4({
    ...scope,
    envelope: {
      commandId,
      clientId: "native-legacy-core-client",
      sessionId,
      type,
      issuedAt,
      baseRevision: snapshot.revision,
      baseLogEpoch: snapshot.logEpoch,
      payload: { target: { rowId: row.rowId, entityId: row.entityId }, ...extra },
    },
  });
}

export async function readLegacyVisibleInputs(
  agent: any,
  scope: WorkspaceScope,
  sessionId: string,
) {
  const { snapshot, subscriptionId } = await currentSnapshot(agent, scope, sessionId);
  await agent.unsubscribeConversationV4({ ...scope, subscriptionId });
  return snapshot.rows.window
    .filter((row) => row.kind === "userInput")
    .map((row) => row.text ?? "");
}

export async function verifyLegacyActions(agent: any, scope: WorkspaceScope, parentId: string) {
  const { snapshot, subscriptionId } = await currentSnapshot(agent, scope, parentId);
  const assistant = [...snapshot.rows.window]
    .reverse()
    .find((row) => row.kind === "assistantText" && row.actions?.canFork === true);
  assert.ok(assistant, "completed provider reply must expose an actual forkable assistant row");
  const forkId = "legacy-core-actual-fork";
  const forkIssuedAt = Date.now();
  const fork = await command(
    agent,
    scope,
    parentId,
    snapshot,
    assistant,
    forkId,
    "forkAssistant",
    {},
    forkIssuedAt,
  );
  assert.equal(fork.status, "accepted", `fork refused: ${fork.reasonCode}`);
  assert.equal(fork.result?.type, "forkAssistant");
  const forkedId = fork.result.sessionId as string;
  assert.notEqual(forkedId, parentId);
  const duplicate = await command(
    agent,
    scope,
    parentId,
    snapshot,
    assistant,
    forkId,
    "forkAssistant",
    {},
    forkIssuedAt,
  );
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.result?.sessionId, forkedId);
  await agent.unsubscribeConversationV4({ ...scope, subscriptionId });

  const editView = await currentSnapshot(agent, scope, parentId);
  const user = [...editView.snapshot.rows.window]
    .reverse()
    .find(
      (row) =>
        row.kind === "userInput" && row.origin === "realUser" && row.actions?.canEdit === true,
    );
  assert.ok(user, "latest actual real user row must expose edit target");
  const editId = "legacy-core-actual-edit";
  const editedText = "revised parent intent from actual row";
  const editPayload = { newText: editedText, workspaceMode: "preserve" };
  const editIssuedAt = Date.now();
  const editTerminal = waitForTerminal(agent, scope, parentId, editId);
  const edit = await command(
    agent,
    scope,
    parentId,
    editView.snapshot,
    user,
    editId,
    "editUserQuery",
    editPayload,
    editIssuedAt,
  );
  assert.equal(edit.status, "accepted", `edit refused: ${edit.reasonCode}`);
  await editTerminal;
  const editDuplicate = await command(
    agent,
    scope,
    parentId,
    editView.snapshot,
    user,
    editId,
    "editUserQuery",
    editPayload,
    editIssuedAt,
  );
  assert.equal(editDuplicate.status, "duplicate", "same edit must not rewind twice");
  await agent.unsubscribeConversationV4({ ...scope, subscriptionId: editView.subscriptionId });

  const retryView = await currentSnapshot(agent, scope, parentId);
  const retryRow = [...retryView.snapshot.rows.window]
    .reverse()
    .find((row) => row.kind === "assistantText" && row.actions?.canRetry === true);
  assert.ok(retryRow, "latest actual assistant row must expose retry target");
  const retryId = "legacy-core-actual-retry";
  const retryIssuedAt = Date.now();
  const retryTerminal = waitForTerminal(agent, scope, parentId, retryId);
  const retry = await command(
    agent,
    scope,
    parentId,
    retryView.snapshot,
    retryRow,
    retryId,
    "retryTurn",
    {},
    retryIssuedAt,
  );
  assert.equal(retry.status, "accepted", `retry refused: ${retry.reasonCode}`);
  await retryTerminal;
  const retryDuplicate = await command(
    agent,
    scope,
    parentId,
    retryView.snapshot,
    retryRow,
    retryId,
    "retryTurn",
    {},
    retryIssuedAt,
  );
  assert.equal(retryDuplicate.status, "duplicate", "same retry must not repeat provider input");
  await agent.unsubscribeConversationV4({ ...scope, subscriptionId: retryView.subscriptionId });
  return {
    forkedId,
    forkTarget: { rowId: assistant.rowId, entityId: assistant.entityId! },
    forkRevision: snapshot.revision,
    editTarget: { rowId: user.rowId, entityId: user.entityId! },
    retryTarget: { rowId: retryRow.rowId, entityId: retryRow.entityId! },
    editStatus: edit.status,
    retryStatus: retry.status,
    editedText,
  };
}
