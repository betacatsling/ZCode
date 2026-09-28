import assert from "node:assert/strict";
import type { ConversationRow, ToolCallRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { isNativeCheckCommand, nativeFixtureRelativePath } from "./certifyNativeV4Common.js";
import {
  diagnoseNativeLiveTurn,
  nativeLiveTurnFailureReasons,
} from "./certifyNativeV4LiveDiagnostics.js";
import type { FakeModelRequest, FakeRequestScenario } from "./certifyNativeV4FakeGateway.js";

type JsonRecord = Record<string, unknown>;

function objectRecord(value: unknown): JsonRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

export function nativeToolInput(
  row: Pick<ToolCallRow, "input" | "inputText">,
): JsonRecord | undefined {
  const direct = objectRecord(row.input);
  if (direct) return direct;
  try {
    return objectRecord(JSON.parse(row.inputText));
  } catch {
    return undefined;
  }
}

export function nativeToolTargetPath(
  row: Pick<ToolCallRow, "input" | "inputText">,
  workspace: string,
): string | undefined {
  const input = nativeToolInput(row);
  const path = input?.file_path ?? input?.path ?? input?.filePath;
  return nativeFixtureRelativePath(path, workspace);
}

export function mayApproveNativeFixtureTool(row: ToolCallRow, workspace: string): boolean {
  if (row.toolName === "Read")
    return ["input.txt", "output.txt", "check.mjs"].includes(
      nativeToolTargetPath(row, workspace) ?? "",
    );
  if (row.toolName === "Write" || row.toolName === "Edit")
    return nativeToolTargetPath(row, workspace) === "output.txt";
  return row.toolName === "Bash" && isNativeCheckCommand(nativeToolInput(row)?.command, workspace);
}

function turnRows(rows: readonly ConversationRow[], turnId: string): ConversationRow[] {
  return rows.filter((row) => row.turnId === turnId);
}

export function assertNativeFullTurn(
  rows: readonly ConversationRow[],
  turnId: string,
  workspace: string,
  logEpoch: string,
): ReturnType<typeof diagnoseNativeLiveTurn> {
  const currentRows = turnRows(rows, turnId);
  const header = currentRows.find((row): row is TurnHeaderRow => row.kind === "turnHeader");
  assert.equal(header?.state, "completedSuccess", "full fixture turn must complete successfully");
  const audit = diagnoseNativeLiveTurn({ rows, currentTurnId: turnId, logEpoch, workspace });
  assert.deepEqual(
    nativeLiveTurnFailureReasons(audit),
    [],
    "full fixture must satisfy required successful outcomes while staying in scope",
  );
  assert.ok(
    audit.toolRows.some(
      (row) =>
        row.tool === "Read" &&
        row.fixturePath === "output.txt" &&
        row.status === "error" &&
        row.classification === "allowed-operation-failed" &&
        row.safeError === "missing-file",
    ),
    "native appserver must retain a bounded diagnostic for the recoverable missing-output Read",
  );
  return audit;
}

export function assertScenarioHistory(
  requests: readonly FakeModelRequest[],
  scenario: FakeRequestScenario,
  fixtureTurnId: string,
  expectedStages: readonly FakeModelRequest["stage"][],
): void {
  const observed = requests
    .filter((request) => request.fixtureTurnId === fixtureTurnId && request.scenario === scenario)
    .map((request) => request.stage);
  assert.deepEqual(
    observed,
    expectedStages,
    `${scenario} fake request history must match its plan`,
  );
  assert.ok(
    requests
      .filter((request) => request.fixtureTurnId === fixtureTurnId && request.scenario === scenario)
      .every((request) => request.scenario === scenario && request.path === "/v1/chat/completions"),
    `${scenario} fake request history must retain its scenario and route identity`,
  );
}
