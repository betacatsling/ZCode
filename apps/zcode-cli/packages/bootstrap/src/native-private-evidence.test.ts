import assert from "node:assert/strict";
import test from "node:test";
import {
  matchingFinalAnswer,
  matchingTerminal,
  nativeEvidenceRows,
  permittedFixtureAction,
  isExactFixtureAction,
} from "./native-private-evidence.js";

test("ACK, stale terminal, wrong session and control-only phase cannot complete a new command", () => {
  const old = {
    kind: "turnHeader",
    turnId: "old",
    sourceCommandId: "fixture-1",
    state: "completedSuccess",
  };
  const frame = (topic: string, row: object) => ({
    method: "v4/conversation/frame",
    params: {
      frame: {
        topic,
        payload: { kind: "deltas", deltas: [{ op: "row.upserted", row }] },
      },
    },
  });
  assert.deepEqual(nativeEvidenceRows({ method: "v4/command", params: {} }, "s"), []);
  assert.deepEqual(nativeEvidenceRows(frame("conversation/other", old), "s"), []);
  assert.equal(
    matchingTerminal(nativeEvidenceRows(frame("conversation/s", old), "s"), "fixture-2"),
    undefined,
  );
  assert.equal(matchingTerminal([old], "fixture-1"), "old");
  assert.equal(
    matchingTerminal(
      [{ kind: "turnHeader", turnId: "new", sourceCommandId: "fixture-2", state: "running" }],
      "fixture-2",
    ),
    undefined,
  );
  assert.equal(
    matchingFinalAnswer(
      [{ kind: "toolCall", turnId: "new", text: "secret-nonce" }],
      "new",
      "secret-nonce",
    ),
    false,
  );
  assert.equal(
    matchingFinalAnswer(
      [{ kind: "assistantText", turnId: "new", state: "streaming", text: "secret-nonce" }],
      "new",
      "secret-nonce",
    ),
    false,
  );
  assert.equal(
    matchingFinalAnswer(
      [{ kind: "assistantText", turnId: "new", state: "complete", text: "secret-nonce" }],
      "new",
      "secret-nonce",
    ),
    true,
  );
});

test("permission gate requires exact params, scope and phase, not tool name", () => {
  const base = {
    toolName: "Bash",
    params: { command: "node verify.cjs" },
    cwd: "sandbox",
    readPath: "input",
    writePath: "output",
    writeContent: "exact",
    bashCommand: "node verify.cjs",
    phase: 1,
    deniedWrites: 0,
  };
  assert.equal(permittedFixtureAction(base), "allow");
  assert.equal(
    isExactFixtureAction({
      ...base,
      toolName: "Write",
      params: { file_path: "output", content: "wrong" },
    }),
    false,
  );
  assert.equal(
    permittedFixtureAction({ ...base, params: { command: "node verify.cjs; cat ~/.ssh/id_rsa" } }),
    "deny",
  );
  assert.equal(
    permittedFixtureAction({ ...base, params: { command: "node verify.cjs", cwd: "/tmp" } }),
    "deny",
  );
  assert.equal(permittedFixtureAction({ ...base, phase: 2 }), "deny");
  assert.equal(
    permittedFixtureAction({
      ...base,
      toolName: "Write",
      params: { file_path: "output", content: "wrong" },
    }),
    "deny",
  );
  assert.equal(
    permittedFixtureAction({
      ...base,
      toolName: "Write",
      params: { file_path: "output", content: "exact" },
    }),
    "deny",
  );
  assert.equal(
    permittedFixtureAction({
      ...base,
      toolName: "Write",
      deniedWrites: 1,
      params: { file_path: "output", content: "exact" },
    }),
    "allow",
  );
});
