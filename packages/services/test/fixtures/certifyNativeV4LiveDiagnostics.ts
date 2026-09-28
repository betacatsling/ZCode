import type { ConversationRow, ToolCallRow, TurnHeaderRow } from "@zcode/shared/zcode-protocol-v4";
import { isNativeCheckCommand, nativeFixtureRelativePath } from "./certifyNativeV4Common.js";
import {
  analyzeNativeBashCommand,
  type NativeBashCommandShape,
  type NativeCommandMismatchReason,
} from "./certifyNativeV4BashShape.js";

export type NativeLiveToolClassification =
  | "unsupported-tool"
  | "outside-fixture-path"
  | "unsupported-fixture-path"
  | "command-mismatch"
  | "allowed-operation-succeeded"
  | "allowed-operation-failed"
  | "allowed-operation-incomplete";

export interface NativeLiveToolDiagnostic {
  readonly toolCallId: string;
  readonly tool: "Read" | "Write" | "Edit" | "Bash" | "unsupported";
  readonly status: ToolCallRow["status"];
  readonly classification: NativeLiveToolClassification;
  readonly fixturePath?: string;
  readonly commandClass?: "fixed-check" | "mismatch";
  readonly commandShape?: NativeBashCommandShape;
  readonly mismatchReason?: NativeCommandMismatchReason;
  readonly safeError?:
    | "missing-file"
    | "permission-denied"
    | "timeout"
    | "cancelled"
    | "tool-error";
}

export interface NativeLiveTurnDiagnostic {
  readonly currentTurnId: string;
  readonly logEpoch: string;
  readonly turnStatus?: TurnHeaderRow["state"];
  readonly toolRows: readonly NativeLiveToolDiagnostic[];
  readonly requiredOutcome: {
    readonly readInput: boolean;
    readonly writeOutput: boolean;
    readonly fixedCheck: boolean;
    readonly terminalAssistantText: boolean;
    readonly missing: readonly string[];
  };
}

type ToolInput = Record<string, unknown>;

function objectRecord(value: unknown): ToolInput | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as ToolInput)
    : undefined;
}

function rowInput(row: Pick<ToolCallRow, "input" | "inputText">): ToolInput | undefined {
  const direct = objectRecord(row.input);
  if (direct) return direct;
  try {
    return objectRecord(JSON.parse(row.inputText));
  } catch {
    return undefined;
  }
}

function safeErrorCategory(row: ToolCallRow): NativeLiveToolDiagnostic["safeError"] {
  if (row.status === "cancelled") return "cancelled";
  const message = `${row.error?.code ?? ""} ${row.error?.message ?? ""}`.toLowerCase();
  if (/enoent|no such file|not found|does not exist/u.test(message)) return "missing-file";
  if (/eacces|eperm|permission denied|not permitted/u.test(message)) return "permission-denied";
  if (/timeout|timed out/u.test(message)) return "timeout";
  return "tool-error";
}

function boundedFixturePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return [...path]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f ? "?" : character;
    })
    .join("")
    .slice(0, 120);
}

function statusClassification(
  row: ToolCallRow,
): "allowed-operation-succeeded" | "allowed-operation-failed" | "allowed-operation-incomplete" {
  if (row.status === "success") return "allowed-operation-succeeded";
  if (row.status === "error" || row.status === "cancelled") return "allowed-operation-failed";
  return "allowed-operation-incomplete";
}

export function diagnoseNativeLiveToolRow(
  row: ToolCallRow,
  workspace: string,
): NativeLiveToolDiagnostic {
  const tool =
    row.toolName === "Read" ||
    row.toolName === "Write" ||
    row.toolName === "Edit" ||
    row.toolName === "Bash"
      ? row.toolName
      : "unsupported";
  const base = {
    toolCallId: row.toolCallId.slice(0, 128),
    tool,
    status: row.status,
  } as const;
  if (tool === "unsupported") return { ...base, classification: "unsupported-tool" };

  const input = rowInput(row);
  if (tool === "Bash") {
    const command = typeof input?.command === "string" ? input.command : "";
    const commandAnalysis = analyzeNativeBashCommand(command, workspace);
    const commandMatches = commandAnalysis.fixedCheck;
    const commandClass = commandMatches ? "fixed-check" : "mismatch";
    if (!commandMatches)
      return {
        ...base,
        commandClass,
        commandShape: commandAnalysis.shape,
        mismatchReason: commandAnalysis.mismatchReason,
        classification: "command-mismatch",
      };
    const classification = statusClassification(row);
    return {
      ...base,
      commandClass,
      commandShape: commandAnalysis.shape,
      classification,
      ...(classification === "allowed-operation-failed"
        ? { safeError: safeErrorCategory(row) }
        : {}),
    };
  }

  const rawPath = input?.file_path ?? input?.path ?? input?.filePath;
  if (typeof rawPath !== "string" || !rawPath.trim())
    return { ...base, classification: "unsupported-fixture-path" };
  const fixturePath = nativeFixtureRelativePath(rawPath, workspace);
  if (!fixturePath) return { ...base, classification: "outside-fixture-path" };
  const allowed =
    tool === "Read"
      ? fixturePath === "input.txt" || fixturePath === "output.txt" || fixturePath === "check.mjs"
      : fixturePath === "output.txt";
  if (!allowed) {
    return {
      ...base,
      classification: "unsupported-fixture-path",
      fixturePath: boundedFixturePath(fixturePath),
    };
  }
  const classification = statusClassification(row);
  return {
    ...base,
    classification,
    fixturePath,
    ...(classification === "allowed-operation-failed" ? { safeError: safeErrorCategory(row) } : {}),
  };
}

export function diagnoseNativeLiveTurn(options: {
  readonly rows: readonly ConversationRow[];
  readonly currentTurnId: string;
  readonly logEpoch: string;
  readonly workspace: string;
}): NativeLiveTurnDiagnostic {
  const currentRows = options.rows
    .filter((row) => row.turnId === options.currentTurnId)
    .toSorted((left, right) => left.rowId - right.rowId);
  const header = currentRows.find((row): row is TurnHeaderRow => row.kind === "turnHeader");
  const toolRows = currentRows
    .filter((row): row is ToolCallRow => row.kind === "toolCall")
    .map((row) => diagnoseNativeLiveToolRow(row, options.workspace));
  const readRows = currentRows.filter(
    (row): row is ToolCallRow =>
      row.kind === "toolCall" && row.status === "success" && row.toolName === "Read",
  );
  const successfulInputRead = readRows.find(
    (row) =>
      nativeFixtureRelativePath(
        rowInput(row)?.file_path ?? rowInput(row)?.path ?? rowInput(row)?.filePath,
        options.workspace,
      ) === "input.txt",
  );
  const successfulOutputWrite = currentRows.find(
    (row): row is ToolCallRow =>
      row.kind === "toolCall" &&
      row.status === "success" &&
      (row.toolName === "Write" || row.toolName === "Edit") &&
      nativeFixtureRelativePath(
        rowInput(row)?.file_path ?? rowInput(row)?.path ?? rowInput(row)?.filePath,
        options.workspace,
      ) === "output.txt" &&
      (!successfulInputRead || row.rowId > successfulInputRead.rowId),
  );
  const successfulCheck = currentRows.filter(
    (row): row is ToolCallRow =>
      row.kind === "toolCall" &&
      row.status === "success" &&
      row.toolName === "Bash" &&
      isNativeCheckCommand(rowInput(row)?.command, options.workspace) &&
      (!successfulOutputWrite || row.rowId > successfulOutputWrite.rowId),
  );
  const terminalAssistantText = currentRows.some(
    (row) =>
      row.kind === "assistantText" &&
      row.state === "complete" &&
      row.text.trim().length > 0 &&
      (!successfulCheck[0] || row.rowId > successfulCheck[0].rowId),
  );
  const requiredOutcome = {
    readInput: successfulInputRead !== undefined,
    writeOutput: successfulOutputWrite !== undefined,
    fixedCheck: successfulCheck.length === 1,
    terminalAssistantText: terminalAssistantText && successfulCheck.length === 1,
    missing: [] as string[],
  };
  if (!requiredOutcome.readInput) requiredOutcome.missing.push("read-input");
  if (!requiredOutcome.writeOutput) requiredOutcome.missing.push("write-output");
  if (!requiredOutcome.fixedCheck) requiredOutcome.missing.push("fixed-check");
  if (header?.state !== "completedSuccess") requiredOutcome.missing.push("completed-success-turn");
  if (!requiredOutcome.terminalAssistantText)
    requiredOutcome.missing.push("terminal-assistant-text");

  return {
    currentTurnId: options.currentTurnId.slice(0, 128),
    logEpoch: options.logEpoch.slice(0, 128),
    ...(header ? { turnStatus: header.state } : {}),
    toolRows,
    requiredOutcome,
  };
}

export function nativeLiveTurnFailureReasons(audit: NativeLiveTurnDiagnostic): string[] {
  const rejectedRows = audit.toolRows.filter(
    (row) =>
      row.classification !== "allowed-operation-succeeded" &&
      row.classification !== "allowed-operation-failed",
  );
  return [
    ...rejectedRows.map((row) => row.classification),
    ...audit.requiredOutcome.missing.map((outcome) => `missing-required-final-outcome:${outcome}`),
  ];
}
