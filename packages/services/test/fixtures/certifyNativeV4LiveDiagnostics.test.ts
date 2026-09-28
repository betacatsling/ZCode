import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow, ToolCallRow } from "@zcode/shared/zcode-protocol-v4";
import {
  diagnoseNativeLiveToolRow,
  diagnoseNativeLiveTurn,
  nativeLiveTurnFailureReasons,
} from "./certifyNativeV4LiveDiagnostics.js";

const workspace = "/tmp/native-live-diagnostic-fixture";

function toolRow(input: {
  readonly toolName: string;
  readonly status?: ToolCallRow["status"];
  readonly input: Record<string, unknown>;
  readonly error?: { readonly code: string; readonly message: string };
  readonly rowId?: number;
}): ToolCallRow {
  return {
    rowId: input.rowId ?? 1,
    turnId: "current-turn",
    kind: "toolCall",
    toolCallId: "call-123",
    toolName: input.toolName,
    status: input.status ?? "error",
    inputText: JSON.stringify(input.input),
    ...(input.error ? { error: input.error } : {}),
  } as ToolCallRow;
}

test("live tool diagnostics distinguish bounded scope and redact tool errors", () => {
  const missingRead = diagnoseNativeLiveToolRow(
    toolRow({
      toolName: "Read",
      input: { file_path: "output.txt" },
      error: { code: "ENOENT", message: `missing /private/${"secret"}` },
    }),
    workspace,
  );
  assert.deepEqual(missingRead, {
    toolCallId: "call-123",
    tool: "Read",
    status: "error",
    classification: "allowed-operation-failed",
    fixturePath: "output.txt",
    safeError: "missing-file",
  });
  assert.equal(JSON.stringify(missingRead).includes("/private"), false);
  assert.equal(JSON.stringify(missingRead).includes("secret"), false);

  assert.equal(
    diagnoseNativeLiveToolRow(toolRow({ toolName: "RunAnything", input: {} }), workspace)
      .classification,
    "unsupported-tool",
  );
  assert.equal(
    diagnoseNativeLiveToolRow(
      toolRow({ toolName: "Write", input: { file_path: "../outside.txt" } }),
      workspace,
    ).classification,
    "outside-fixture-path",
  );
  assert.equal(
    diagnoseNativeLiveToolRow(
      toolRow({ toolName: "Read", input: { file_path: "private.txt" } }),
      workspace,
    ).classification,
    "unsupported-fixture-path",
  );
  const mismatch = diagnoseNativeLiveToolRow(
    toolRow({
      toolName: "Bash",
      input: { command: "node -e 'process.stdout.write(\"CANARYSECRET\")'" },
    }),
    workspace,
  );
  assert.equal(mismatch.classification, "command-mismatch");
  assert.equal(mismatch.mismatchReason, "fixed-check-path-missing");
  assert.equal(mismatch.commandShape?.head, "node");
  assert.deepEqual(mismatch.commandShape?.knownFixturePaths, []);
  assert.deepEqual(mismatch.commandShape?.operatorKinds, []);
  assert.equal(JSON.stringify(mismatch).includes("CANARYSECRET"), false);

  const compound = diagnoseNativeLiveToolRow(
    toolRow({
      toolName: "Bash",
      input: { command: `node ${workspace}/check.mjs && cat output.txt` },
    }),
    workspace,
  );
  assert.equal(compound.mismatchReason, "shell-operator-present");
  assert.deepEqual(compound.commandShape?.knownFixturePaths, ["check.mjs", "output.txt"]);
  assert.deepEqual(compound.commandShape?.operatorKinds, ["and"]);
  assert.equal(JSON.stringify(compound).includes(workspace), false);
});

test("live turn diagnostics report missing final outcomes per current turn", () => {
  const rows = [
    {
      rowId: 1,
      turnId: "old-turn",
      kind: "toolCall",
      toolCallId: "old-call",
      toolName: "Read",
      status: "success",
      inputText: JSON.stringify({ file_path: "input.txt" }),
    },
    {
      rowId: 2,
      turnId: "current-turn",
      kind: "turnHeader",
      state: "failed",
    },
  ] as unknown as ConversationRow[];
  const audit = diagnoseNativeLiveTurn({
    rows,
    currentTurnId: "current-turn",
    logEpoch: "current-epoch",
    workspace,
  });
  assert.deepEqual(audit.toolRows, []);
  assert.equal(audit.logEpoch, "current-epoch");
  assert.deepEqual(nativeLiveTurnFailureReasons(audit), [
    "missing-required-final-outcome:read-input",
    "missing-required-final-outcome:write-output",
    "missing-required-final-outcome:fixed-check",
    "missing-required-final-outcome:completed-success-turn",
    "missing-required-final-outcome:terminal-assistant-text",
  ]);
});

test("a successful fixed-task turn still rejects a mismatched Bash command", () => {
  const rows = [
    { rowId: 1, turnId: "current-turn", kind: "turnHeader", state: "completedSuccess" },
    toolRow({
      rowId: 2,
      toolName: "Read",
      status: "success",
      input: { file_path: "input.txt" },
    }),
    toolRow({
      rowId: 3,
      toolName: "Write",
      status: "success",
      input: { file_path: "output.txt" },
    }),
    toolRow({
      rowId: 4,
      toolName: "Bash",
      status: "success",
      input: { command: "node -e 'process.exit(0)'" },
    }),
    {
      rowId: 5,
      turnId: "current-turn",
      kind: "assistantText",
      state: "complete",
      text: "done",
    },
  ] as unknown as ConversationRow[];
  const audit = diagnoseNativeLiveTurn({
    rows,
    currentTurnId: "current-turn",
    logEpoch: "current-epoch",
    workspace,
  });
  assert.ok(nativeLiveTurnFailureReasons(audit).includes("command-mismatch"));
  assert.equal(audit.toolRows.at(-1)?.classification, "command-mismatch");
});
