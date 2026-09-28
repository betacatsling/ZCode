import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  V4_METHODS,
  v4ConversationRowsRangeResultSchema,
  type ConversationRow,
  type ToolCallRow,
  type TurnHeaderRow,
} from "@zcode/shared/zcode-protocol-v4";
import { ZCodeProtocolClient } from "../../src/zcode-agent/zcodeProtocolClient.js";
import {
  assertNativeFullTurn,
  assertScenarioHistory,
  mayApproveNativeFixtureTool,
  nativeToolInput,
  nativeToolTargetPath,
} from "./certifyNativeV4FakeAssertions.js";
import {
  type FakeGatewayState,
  type FakeModelRequest,
  type NativeFakeScenario,
} from "./certifyNativeV4FakeGateway.js";
import {
  NativeV4ConversationState,
  type CurrentPendingPermission,
} from "./certifyNativeV4ConversationState.js";
import { objectRecord, sendNativeCommand } from "./certifyNativeV4FakeProtocol.js";
import {
  diagnoseNativeLiveToolRow,
  type NativeLiveToolDiagnostic,
} from "./certifyNativeV4LiveDiagnostics.js";

interface FakeScenarioDependencies {
  readonly client: ZCodeProtocolClient;
  readonly conversation: NativeV4ConversationState;
  readonly gateway: FakeGatewayState;
  readonly requests: readonly FakeModelRequest[];
  readonly sessionId: string;
  readonly workspace: string;
  readonly mode: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly resolutionAcks: unknown[];
}

export interface NativeFakeScenarioResult {
  readonly fixtureTurnId: string;
  readonly turnId: string;
  readonly rows: readonly ConversationRow[];
  readonly diagnostics?: readonly NativeLiveToolDiagnostic[];
  readonly diagnosticLogEpoch?: string;
}

const TURN_WAIT_MS = 45_000;

function newFixtureTurnId(scenario: NativeFakeScenario): string {
  return `native-${scenario}-${randomUUID()}`;
}

function newTurnHeader(
  conversation: NativeV4ConversationState,
  previousTurnCount: number,
): TurnHeaderRow | undefined {
  return conversation.turnHeaders()[previousTurnCount];
}

async function waitForNewTurn(
  conversation: NativeV4ConversationState,
  previousTurnCount: number,
): Promise<TurnHeaderRow> {
  while (true) {
    const version = conversation.changeVersion;
    conversation.assertHealthy();
    const header = newTurnHeader(conversation, previousTurnCount);
    if (header) return header;
    await conversation.waitForChange(version, TURN_WAIT_MS);
  }
}

async function readHistory(
  client: ZCodeProtocolClient,
  sessionId: string,
): Promise<ConversationRow[]> {
  const rows = await client.request(
    V4_METHODS.conversationRowsRange,
    { sessionId, limit: 200 },
    v4ConversationRowsRangeResultSchema,
  );
  return rows.rows;
}

async function waitForTurnState(
  dependencies: FakeScenarioDependencies,
  previousTurnCount: number,
  expected: "completedSuccess" | "completedInterrupted",
  autoAllowFixtureTools: boolean,
  resolvedInteractionIds: Set<string> = new Set(),
): Promise<NativeFakeScenarioResult> {
  const { client, conversation, sessionId, workspace, resolutionAcks } = dependencies;
  while (true) {
    const version = conversation.changeVersion;
    conversation.assertHealthy();
    const header = newTurnHeader(conversation, previousTurnCount);
    if (header) {
      const pending = conversation.pendingPermissionsForTurn(header.turnId);
      for (const { interaction, toolRow } of pending) {
        if (resolvedInteractionIds.has(interaction.interactionId)) continue;
        assert.ok(
          autoAllowFixtureTools && mayApproveNativeFixtureTool(toolRow, workspace),
          `fake ${header.turnId} requested approval outside its exact scenario operations: ${JSON.stringify(
            {
              toolName: toolRow.toolName,
              status: toolRow.status,
              path: nativeToolTargetPath(toolRow, workspace),
              interactionId: interaction.interactionId,
            },
          )}`,
        );
        const ack = await sendNativeCommand(client, sessionId, "resolveInteraction", {
          interactionId: interaction.interactionId,
          answer: { optionId: "allowOnce" },
        });
        assert.equal(objectRecord(ack)?.status, "accepted", JSON.stringify(ack));
        resolvedInteractionIds.add(interaction.interactionId);
        resolutionAcks.push({ allowed: ack });
      }
      if (header.state === expected) {
        const rows = await readHistory(client, sessionId);
        return { fixtureTurnId: "", turnId: header.turnId, rows };
      }
      if (header.state === "failed") throw new Error(`native fake turn ${header.turnId} failed`);
    }
    await conversation.waitForChange(version, TURN_WAIT_MS);
  }
}

async function sendScenarioPrompt(
  dependencies: FakeScenarioDependencies,
  scenario: NativeFakeScenario,
  text: string,
): Promise<{ readonly fixtureTurnId: string; readonly previousTurnCount: number }> {
  const { client, conversation, gateway, sessionId, mode, providerId, modelId } = dependencies;
  const previousTurnCount = conversation.turnHeaders().length;
  const fixtureTurnId = newFixtureTurnId(scenario);
  gateway.beginTurn(scenario, fixtureTurnId, text);
  const ack = await sendNativeCommand(client, sessionId, "sendText", {
    text,
    requestedDelivery: "startNow",
    mode,
    modelSelection: {
      providerId,
      modelId,
      options: { reasoningLevel: "off" },
    },
  });
  assert.equal(objectRecord(ack)?.status, "accepted", JSON.stringify(ack));
  return { fixtureTurnId, previousTurnCount };
}

export async function runNativeFullScenario(
  dependencies: FakeScenarioDependencies,
): Promise<NativeFakeScenarioResult> {
  const scenario = await sendScenarioPrompt(
    dependencies,
    "full",
    "This is a small fixture. If useful, check whether output.txt exists first; if it is absent, continue. Read input.txt, then write output.txt with exactly native live output followed by one newline. Call Bash exactly once to run the supplied check script with exactly `node ./check.mjs`; after it finishes, report whether it passed without further tool calls. Do not plan, delegate, ask questions, or change check.mjs or other files.",
  );
  const result = await waitForTurnState(
    dependencies,
    scenario.previousTurnCount,
    "completedSuccess",
    true,
  );
  dependencies.gateway.finishTurn(scenario.fixtureTurnId);
  const finalResult = { ...result, fixtureTurnId: scenario.fixtureTurnId };
  const logEpoch = dependencies.conversation.snapshot?.logEpoch;
  assert.ok(logEpoch, "native fake full turn must have a subscribed snapshot epoch");
  const audit = assertNativeFullTurn(
    finalResult.rows,
    finalResult.turnId,
    dependencies.workspace,
    logEpoch,
  );
  assertScenarioHistory(dependencies.requests, "full", scenario.fixtureTurnId, [
    "read",
    "read",
    "write",
    "bash",
    "text",
  ]);
  return { ...finalResult, diagnostics: audit.toolRows, diagnosticLogEpoch: audit.logEpoch };
}

export async function runNativeFollowupScenario(
  dependencies: FakeScenarioDependencies,
): Promise<NativeFakeScenarioResult> {
  const scenario = await sendScenarioPrompt(
    dependencies,
    "followup",
    "Follow up: state whether the supplied fixture check passed. Do not change files.",
  );
  const result = await waitForTurnState(
    dependencies,
    scenario.previousTurnCount,
    "completedSuccess",
    false,
  );
  dependencies.gateway.finishTurn(scenario.fixtureTurnId);
  const finalResult = { ...result, fixtureTurnId: scenario.fixtureTurnId };
  const turnRows = finalResult.rows.filter((row) => row.turnId === finalResult.turnId);
  assert.equal(
    turnRows.some((row) => row.kind === "toolCall"),
    false,
    "follow-up must complete independently without calling tools",
  );
  assert.ok(
    turnRows.some(
      (row) => row.kind === "assistantText" && row.state === "complete" && row.text.length > 0,
    ),
  );
  assertScenarioHistory(dependencies.requests, "followup", scenario.fixtureTurnId, ["text"]);
  return finalResult;
}

async function waitForPendingPermission(
  conversation: NativeV4ConversationState,
  turnId: string,
): Promise<CurrentPendingPermission> {
  while (true) {
    const version = conversation.changeVersion;
    conversation.assertHealthy();
    const pending = conversation.pendingPermissionsForTurn(turnId)[0];
    if (pending) return pending;
    await conversation.waitForChange(version, TURN_WAIT_MS);
  }
}

export async function runNativeDenyScenario(
  dependencies: FakeScenarioDependencies,
): Promise<NativeFakeScenarioResult> {
  const scenario = await sendScenarioPrompt(
    dependencies,
    "deny",
    "Ask for approval, then attempt to write ../native-denied-sentinel.txt exactly once. Do not create it before approval.",
  );
  const header = await waitForNewTurn(dependencies.conversation, scenario.previousTurnCount);
  const pending = await waitForPendingPermission(dependencies.conversation, header.turnId);
  assert.equal(pending.interaction.kind, "permission");
  assert.equal(pending.toolRow.toolName, "Write");
  const requestedPath =
    nativeToolInput(pending.toolRow)?.file_path ??
    nativeToolInput(pending.toolRow)?.path ??
    nativeToolInput(pending.toolRow)?.filePath;
  const deniedPath = resolve(dependencies.workspace, "..", "native-denied-sentinel.txt");
  assert.equal(resolve(dependencies.workspace, String(requestedPath ?? "")), deniedPath);
  assert.equal(nativeToolTargetPath(pending.toolRow, dependencies.workspace), undefined);
  const ack = await sendNativeCommand(
    dependencies.client,
    dependencies.sessionId,
    "resolveInteraction",
    {
      interactionId: pending.interaction.interactionId,
      answer: { optionId: "deny" },
    },
  );
  assert.equal(objectRecord(ack)?.status, "accepted", JSON.stringify(ack));
  dependencies.resolutionAcks.push({ denied: ack });
  const resolved = new Set([pending.interaction.interactionId]);
  const result = await waitForTurnState(
    dependencies,
    scenario.previousTurnCount,
    "completedSuccess",
    false,
    resolved,
  );
  dependencies.gateway.finishTurn(scenario.fixtureTurnId);
  const finalResult = { ...result, fixtureTurnId: scenario.fixtureTurnId };
  const deniedRow = finalResult.rows.find(
    (row): row is ToolCallRow =>
      row.kind === "toolCall" && row.toolCallId === pending.toolRow.toolCallId,
  );
  // 原因：当前 V4 CLI 将用户拒绝投影为 cancelled；以稳定 toolCallId 校验终态，并由文件缺失证明无写入。
  assert.equal(deniedRow?.status, "cancelled", "declined permission must block its write");
  assertScenarioHistory(dependencies.requests, "deny", scenario.fixtureTurnId, ["write", "text"]);
  assert.ok(deniedRow);
  const deniedDiagnostic = diagnoseNativeLiveToolRow(deniedRow, dependencies.workspace);
  assert.equal(deniedDiagnostic.classification, "outside-fixture-path");
  await assert.rejects(readFile(deniedPath), { code: "ENOENT" });
  return {
    ...finalResult,
    diagnostics: [deniedDiagnostic],
    diagnosticLogEpoch: dependencies.conversation.snapshot?.logEpoch,
  };
}

export async function runNativeStopScenario(
  dependencies: FakeScenarioDependencies,
): Promise<NativeFakeScenarioResult> {
  const scenario = await sendScenarioPrompt(
    dependencies,
    "stop",
    "Reply only after the Provider response arrives.",
  );
  await waitForNewTurn(dependencies.conversation, scenario.previousTurnCount);
  await dependencies.gateway.waitForTurnRequest(scenario.fixtureTurnId);
  const stopAck = await sendNativeCommand(dependencies.client, dependencies.sessionId, "stop", {});
  assert.equal(objectRecord(stopAck)?.status, "accepted", JSON.stringify(stopAck));
  dependencies.gateway.releaseStopTurn(scenario.fixtureTurnId);
  const result = await waitForTurnState(
    dependencies,
    scenario.previousTurnCount,
    "completedInterrupted",
    false,
  );
  dependencies.gateway.finishTurn(scenario.fixtureTurnId);
  const finalResult = { ...result, fixtureTurnId: scenario.fixtureTurnId };
  assertScenarioHistory(dependencies.requests, "stop", scenario.fixtureTurnId, ["stop"]);
  assert.ok(
    finalResult.rows.some(
      (row) =>
        row.turnId === finalResult.turnId &&
        row.kind === "turnHeader" &&
        row.state === "completedInterrupted",
    ),
    "stop must persist the interrupted turn in history",
  );
  return finalResult;
}
