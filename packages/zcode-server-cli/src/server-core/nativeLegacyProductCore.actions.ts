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
  stalePair: { status: string; reasonCode?: string };
  staleRevision: { status: string; reasonCode?: string };
  permissionDenial: { status: string; noEffect: boolean };
  permissionApproval: {
    status: string;
    effectBytes: string;
    continuedWithToolResult: boolean;
    staleStatus: string;
  };
  heldStop: { status: string; interrupted: boolean; foregroundExecutionId: string | null };
  replayable: {
    profile: string;
    initialMode: string;
    resumeMode: string;
    resumeFromSeq: number;
    resumeToSeq: number;
    replayedStopTurn: boolean;
    snapshotMode: string;
    sameSubscription: boolean;
    modelCallsUnchanged: boolean;
  };
  rewoundInputsAbsent: boolean;
  editContextPreserved: boolean;
  heldStopRequestRecorded: boolean;
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
  control?: {
    activeWorks?: Array<{ kind: string; foregroundExecutionId?: string }>;
  };
}

/** Read an actual public CLI snapshot; never manufacture display row identities from SQLite. */
export async function currentSnapshot(agent: any, scope: WorkspaceScope, sessionId: string) {
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

  // 负例（区分 byte-identical duplicate）：retry 成功后，原 retryTarget 所在分支已被
  // rewind 截断，{rowId, entityId} 这对组合在投影中失效。新 commandId + 当前
  // revision/epoch + 失效 pair 必须被判 stale，而不是再触发一次 mutation。
  const staleView = await currentSnapshot(agent, scope, parentId);
  const stalePair = await command(
    agent,
    scope,
    parentId,
    staleView.snapshot,
    retryRow,
    "legacy-core-stale-pair",
    "retryTurn",
  );
  assert.equal(stalePair.status, "stale", `stale pair ack: ${JSON.stringify(stalePair)}`);
  // 区分「合法 pair + 陈旧 revision/epoch」与「当前 envelope + 失效 pair」：
  // 当前仍合法的最新 assistant row + 旧 baseRevision 同样必须 stale。
  const freshRetryRow = [...staleView.snapshot.rows.window]
    .reverse()
    .find((row) => row.kind === "assistantText" && row.actions?.canRetry === true);
  assert.ok(freshRetryRow?.entityId, "post-retry snapshot must expose a fresh retryable row");
  const staleRevision = await agent.sendConversationCommandV4({
    ...scope,
    envelope: {
      commandId: "legacy-core-stale-revision",
      clientId: "native-legacy-core-client",
      sessionId: parentId,
      type: "retryTurn",
      issuedAt: Date.now(),
      baseRevision: retryView.snapshot.revision,
      baseLogEpoch: staleView.snapshot.logEpoch,
      payload: {
        target: { rowId: freshRetryRow.rowId, entityId: freshRetryRow.entityId },
      },
    },
  });
  assert.equal(
    staleRevision.status,
    "stale",
    `stale revision ack: ${JSON.stringify(staleRevision)}`,
  );
  // 被拒命令不得改变状态：重新取快照，revision/logEpoch 必须与 stale 判决前一致，
  // 且不得产生新的 Model 请求（计数由 fixture 断言）。
  const unchangedView = await currentSnapshot(agent, scope, parentId);
  assert.equal(unchangedView.snapshot.revision, staleView.snapshot.revision);
  assert.equal(unchangedView.snapshot.logEpoch, staleView.snapshot.logEpoch);
  await agent.unsubscribeConversationV4({ ...scope, subscriptionId: staleView.subscriptionId });
  await agent.unsubscribeConversationV4({ ...scope, subscriptionId: unchangedView.subscriptionId });
  return {
    forkedId,
    forkTarget: { rowId: assistant.rowId, entityId: assistant.entityId! },
    forkRevision: snapshot.revision,
    editTarget: { rowId: user.rowId, entityId: user.entityId! },
    retryTarget: { rowId: retryRow.rowId, entityId: retryRow.entityId! },
    editStatus: edit.status,
    retryStatus: retry.status,
    stalePair: { status: stalePair.status, reasonCode: stalePair.reasonCode },
    staleRevision: { status: staleRevision.status, reasonCode: staleRevision.reasonCode },
    editedText,
  };
}
