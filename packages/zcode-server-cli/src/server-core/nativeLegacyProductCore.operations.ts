import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createZCodeAgentConnectionScope } from "@zcode/services";
import { V4_WIRE_PROTOCOL_VERSION } from "@zcode/shared/zcode-protocol-v4";
import {
  sendText,
  waitForTerminal,
  waitForTurnState,
  type WorkspaceScope,
} from "./nativeLegacyProductCore.protocol.js";
import { currentSnapshot } from "./nativeLegacyProductCore.actions.js";
import { WRITE_CONTENT, WRITE_FILE_NAME } from "./nativeLegacyProductCore.model.js";

interface PermissionOption {
  optionId: string;
  kind: string;
}

interface Interaction {
  interactionId: string;
  kind: string;
  payload: {
    kind: string;
    toolName?: string;
    detail?: unknown;
    options?: PermissionOption[];
  };
}

/** 早建晚等的 Promise：任一先失败时其余 rejection 不能成为 unhandled 抢先把 fixture 进程打挂。 */
function guarded<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {});
  return promise;
}

/**
 * 等待该会话真实投影出的 Write 权限交互。必须在仍有活跃订阅时调用——
 * 没有订阅，CLI 不会向该 workspace 连接投递任何 conversation 帧。
 */
function nextWritePermission(
  agent: any,
  scope: WorkspaceScope,
  sessionId: string,
  target: string,
): Promise<Interaction> {
  return new Promise((resolve, reject) => {
    const observed: string[] = [];
    const timer = setTimeout(() => {
      listener.dispose();
      reject(
        new Error(
          `No actual projected Write permission arrived: ${observed.slice(-12).join("; ")}`,
        ),
      );
    }, 15000);
    const listener = agent.onDynamicConversationFrame(scope)((wire: any) => {
      const frame = wire.frame ?? wire;
      if (frame.topic !== `conversation/${sessionId}`) return;
      const payload = frame.payload;
      const arrays =
        payload?.kind === "snapshot"
          ? [payload.snapshot?.pendingInteractions]
          : (payload?.deltas ?? [])
              .filter((delta: any) => delta.patch?.pendingInteractions)
              .map((delta: any) => delta.patch.pendingInteractions);
      for (const candidates of arrays) {
        if (candidates?.length)
          observed.push(
            JSON.stringify(
              candidates.map((entry: Interaction) => ({
                kind: entry.kind,
                toolName: entry.payload?.toolName,
                detail: entry.payload?.detail,
              })),
            ),
          );
        const found = (candidates ?? []).find(
          (entry: Interaction) =>
            entry.kind === "permission" &&
            entry.payload?.toolName === "Write" &&
            (entry.payload.detail as { file_path?: string })?.file_path === target,
        );
        if (!found) continue;
        clearTimeout(timer);
        listener.dispose();
        resolve(found);
        return;
      }
    });
  });
}

/** 权限选项以投影出的 options 为准：按 kind 取真实 optionId，不写死客户端词汇。 */
function optionIdByKind(interaction: Interaction, kind: string): string {
  const option = (interaction.payload.options ?? []).find((entry) => entry.kind === kind);
  assert.ok(
    option,
    `permission options lack kind=${kind}: ${JSON.stringify(interaction.payload.options)}`,
  );
  return option.optionId;
}

function resolveInteraction(
  agent: any,
  scope: WorkspaceScope,
  sessionId: string,
  interactionId: string,
  optionId: string,
  commandId: string,
) {
  return agent.sendConversationCommandV4({
    ...scope,
    envelope: {
      commandId,
      clientId: "native-legacy-core-client",
      sessionId,
      type: "resolveInteraction",
      issuedAt: Date.now(),
      payload: { interactionId, answer: { optionId } },
    },
  });
}

/**
 * 真实 tool→permission 链路：build 模式下 provider 发出注册 Write tool_use，
 * CLI 投影 pendingInteractions；deny 一次证明零副作用，allowOnce 一次证明
 * 精确字节落盘且 tool_result 回到下一次 Model 请求；迟到/陈旧决策只是幂等 noop。
 */
export async function verifyPermissionOperations(
  agent: any,
  scope: WorkspaceScope,
  sessionId: string,
  cwd: string,
  requests: string[],
  calls: string[],
) {
  const path = join(cwd, WRITE_FILE_NAME);
  const view = await currentSnapshot(agent, scope, sessionId);
  try {
    const mode = await agent.sendConversationCommandV4({
      ...scope,
      envelope: {
        commandId: "legacy-permission-build-mode",
        clientId: "native-legacy-core-client",
        sessionId,
        type: "switchCollaborationMode",
        issuedAt: Date.now(),
        baseRevision: view.snapshot.revision,
        baseLogEpoch: view.snapshot.logEpoch,
        payload: { mode: "build" },
      },
    });
    assert.equal(mode.status, "accepted", `mode: ${JSON.stringify(mode)}`);

    // 第一次：拒绝。view 订阅保持活跃，pendingInteractions 增量才能到达本连接。
    const denied = guarded(nextWritePermission(agent, scope, sessionId, path));
    const first = "legacy-core-write-denied";
    const deniedTerminal = guarded(waitForTerminal(agent, scope, sessionId, first));
    const firstAck = await sendText(agent, scope, sessionId, first, "legacy permission denied");
    assert.equal(firstAck.status, "accepted", `first: ${JSON.stringify(firstAck)}`);
    const deniedInteraction = await denied.catch(async (error: Error) => {
      const state = await currentSnapshot(agent, scope, sessionId);
      await agent.unsubscribeConversationV4({ ...scope, subscriptionId: state.subscriptionId });
      throw new Error(
        `${error.message}; modelCalls=${calls.length}; mode=${(state.snapshot as any).config?.mode}; ` +
          `rows=${JSON.stringify(state.snapshot.rows.window.slice(-5).map((row) => ({ kind: row.kind, status: (row as any).status, text: row.text, error: (row as any).error })))}; ` +
          `pending=${JSON.stringify((state.snapshot as any).pendingInteractions)}`,
      );
    });
    const denial = await resolveInteraction(
      agent,
      scope,
      sessionId,
      deniedInteraction.interactionId,
      optionIdByKind(deniedInteraction, "deny"),
      "legacy-deny-write",
    );
    assert.equal(denial.status, "accepted");
    await deniedTerminal;
    let noEffect = false;
    try {
      await readFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") noEffect = true;
      else throw error;
    }
    assert.ok(noEffect, "denied Write must not create a file");

    // 第二次：批准一次，证明真实文件副作用与 tool_result 续传。
    const approved = guarded(nextWritePermission(agent, scope, sessionId, path));
    const second = "legacy-core-write-approved";
    const approvedTerminal = guarded(waitForTerminal(agent, scope, sessionId, second));
    const secondAck = await sendText(agent, scope, sessionId, second, "legacy permission approved");
    assert.equal(secondAck.status, "accepted");
    const approvedInteraction = await approved;
    assert.notEqual(approvedInteraction.interactionId, deniedInteraction.interactionId);
    const approval = await resolveInteraction(
      agent,
      scope,
      sessionId,
      approvedInteraction.interactionId,
      optionIdByKind(approvedInteraction, "allowOnce"),
      "legacy-allow-write",
    );
    assert.equal(approval.status, "accepted");
    await approvedTerminal;
    const effectBytes = await readFile(path, "utf8");
    // 陈旧交互的迟到决策是无害幂等 noop，绝不能授权出第二次副作用。
    const stale = await resolveInteraction(
      agent,
      scope,
      sessionId,
      deniedInteraction.interactionId,
      optionIdByKind(approvedInteraction, "allowOnce"),
      "legacy-stale-allow",
    );
    assert.equal(await readFile(path, "utf8"), effectBytes);
    return {
      permissionDenial: { status: denial.status, noEffect },
      permissionApproval: {
        status: approval.status,
        effectBytes,
        // 请求体是 JSON，WRITE_CONTENT 末尾的换行会被转义，所以按去换行后的前缀匹配。
        continuedWithToolResult: requests
          .slice(7)
          .some((body) => body.includes("tool_result") && body.includes(WRITE_CONTENT.trimEnd())),
        staleStatus: stale.status,
      },
      callsAfterOperations: calls.length,
    };
  } finally {
    await agent.unsubscribeConversationV4({ ...scope, subscriptionId: view.subscriptionId });
  }
}

/**
 * held stop + web-remote-replayable 恢复。
 *
 * 先挂一条 replayable attachment（与生产 /ws 端点同一个 connection-scope facade），
 * 记录其初始 snapshot 的 (logEpoch, seq)。随后让一轮 turn 停在「上游响应仍被挂起」
 * 的状态，用投影里的 foregroundExecutionId 发 stop：前台执行必须终止为
 * completedInterrupted，且不得再触发任何已接受输入。最后同一条 replayable
 * subscription 用 base cursor 做 same-sub resync（resume 回放缺口）与
 * forceSnapshot（整帧重对齐）；两条路都不允许重发输入或换 subscriptionId。
 */
export async function verifyHeldStopAndReplayable(
  agent: any,
  scope: WorkspaceScope,
  sessionId: string,
  heldRequest: Promise<void>,
  releaseHeld: () => void,
  calls: string[],
) {
  const connectionScope = createZCodeAgentConnectionScope(agent, {
    connectionId: "native-legacy-web-remote",
    clientMode: "web-remote-replayable",
  });
  const frames: any[] = [];
  const listener = connectionScope.service.onDynamicConversationFrame(scope)((wire: any) =>
    frames.push(wire.frame ?? wire),
  );
  try {
    const hello = await connectionScope.service.helloConversationV4();
    assert.equal(hello.clientMode, "web-remote-replayable");
    assert.equal(hello.deliveryProfile, "replayable");
    await connectionScope.service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      clientId: "native-legacy-web-client",
      appVersion: "legacy-fixture",
    });
    const subscribed = await connectionScope.service.subscribeConversationV4({
      ...scope,
      sessionId,
    });
    assert.equal(subscribed.ack.mode, "snapshot");
    const subscriptionId = subscribed.ack.subscriptionId;
    const initial = await waitForFrame(
      frames,
      0,
      (frame) => frame.subscriptionId === subscriptionId && frame.payload?.kind === "snapshot",
      "initial replayable snapshot",
    );
    const baseSeq = initial.toSeq;
    const baseEpoch = subscribed.ack.logEpoch;

    // held stop：上游 Model 响应挂起期间，stop 必须终止该前台执行。
    const stopInputCommand = "legacy-core-held-stop-input";
    const stopCommand = "legacy-core-held-stop";
    const interrupted = guarded(
      waitForTurnState(agent, scope, sessionId, stopInputCommand, "completedInterrupted"),
    );
    const sendAck = await sendText(
      agent,
      scope,
      sessionId,
      stopInputCommand,
      "legacy stop held input",
    );
    assert.equal(sendAck.status, "accepted", `held send: ${JSON.stringify(sendAck)}`);
    await heldRequest;
    const runningView = await currentSnapshot(agent, scope, sessionId);
    const foregroundExecutionId =
      runningView.snapshot.control?.activeWorks?.find((work) => work.foregroundExecutionId)
        ?.foregroundExecutionId ?? null;
    const stopAck = await agent.sendConversationCommandV4({
      ...scope,
      envelope: {
        commandId: stopCommand,
        clientId: "native-legacy-core-client",
        sessionId,
        type: "stop",
        issuedAt: Date.now(),
        payload: foregroundExecutionId
          ? { expectedForegroundExecutionId: foregroundExecutionId }
          : {},
      },
    });
    assert.equal(stopAck.status, "accepted", `stop: ${JSON.stringify(stopAck)}`);
    await interrupted;
    // 上游响应仍处于挂起态时客户端已 abort；释放 fake model 让它收尾，不回喷新的已接受输入。
    releaseHeld();
    await agent.unsubscribeConversationV4({
      ...scope,
      subscriptionId: runningView.subscriptionId,
    });
    const callsAfterStop = calls.length;

    // replayable same-sub 恢复：客户端声明只应用到 baseSeq，CLI 回放 (baseSeq, current]。
    const resumeMark = frames.length;
    const resumeAck = await connectionScope.service.resyncConversationV4({
      ...scope,
      subscriptionId,
      base: { logEpoch: baseEpoch, seq: baseSeq },
    });
    assert.equal(resumeAck.ack.mode, "resume");
    assert.equal(resumeAck.ack.subscriptionId, subscriptionId);
    const resumeFrame = await waitForFrame(
      frames,
      resumeMark,
      (frame) =>
        frame.subscriptionId === subscriptionId &&
        frame.payload?.kind === "deltas" &&
        frame.fromSeq === baseSeq,
      "replayable resume deltas",
    );
    const replayedStopTurn = resumeFrame.payload.deltas.some(
      (delta: any) =>
        (delta.op === "row.upserted" || delta.op === "row.appended") &&
        delta.row?.kind === "turnHeader" &&
        delta.row?.sourceCommandId === stopInputCommand &&
        delta.row?.state === "completedInterrupted",
    );

    // forceSnapshot：cursor 失效路径 → 整帧快照重对齐，同一 subscriptionId。
    const snapshotMark = frames.length;
    const snapshotAck = await connectionScope.service.resyncConversationV4({
      ...scope,
      subscriptionId,
      base: { logEpoch: baseEpoch, seq: baseSeq },
      forceSnapshot: true,
    });
    assert.equal(snapshotAck.ack.mode, "snapshot");
    assert.equal(snapshotAck.ack.subscriptionId, subscriptionId);
    const snapshotFrame = await waitForFrame(
      frames,
      snapshotMark,
      (frame) =>
        frame.subscriptionId === subscriptionId &&
        frame.payload?.kind === "snapshot" &&
        frame.fromSeq === 0,
      "replayable force snapshot",
    );
    assert.ok(snapshotFrame.toSeq >= resumeFrame.toSeq);
    assert.equal(calls.length, callsAfterStop, "replayable recovery must not resend any input");
    return {
      heldStop: {
        status: stopAck.status,
        interrupted: true,
        foregroundExecutionId,
      },
      replayable: {
        profile: hello.deliveryProfile,
        initialMode: subscribed.ack.mode,
        resumeMode: resumeAck.ack.mode,
        resumeFromSeq: resumeFrame.fromSeq,
        resumeToSeq: resumeFrame.toSeq,
        replayedStopTurn,
        snapshotMode: snapshotAck.ack.mode,
        sameSubscription: snapshotAck.ack.subscriptionId === subscriptionId,
        modelCallsUnchanged: calls.length === callsAfterStop,
      },
    };
  } finally {
    listener.dispose();
    await connectionScope.dispose();
  }
}

function waitForFrame(
  frames: any[],
  fromIndex: number,
  predicate: (frame: any) => boolean,
  label: string,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const check = () => {
      const found = frames.slice(fromIndex).find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error(`timed out waiting for ${label}`));
        return;
      }
      setTimeout(check, 25);
    };
    check();
  });
}
