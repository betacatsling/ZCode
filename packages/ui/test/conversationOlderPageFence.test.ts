import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { canMergeOlderPage, mergeOlderRows } from "../src/v4/conversationProjectionStore.js";

function row(rowId: number, value: string): ConversationRow {
  return { rowId, value } as unknown as ConversationRow;
}

const read = {
  requestedGeneration: 3,
  currentGeneration: 3,
  requestedRevision: 7,
  currentRevision: 7,
  requestedEpoch: "epoch-1",
  resultEpoch: "epoch-1",
  currentEpoch: "epoch-1",
  requestedBeforeRowId: 20,
  currentBeforeRowId: 20,
};

test("old pages cannot resurrect rows after a concurrent revision, cursor change or reconnect", () => {
  assert.equal(canMergeOlderPage(read), true);
  for (const change of [
    { currentRevision: 8 },
    { currentGeneration: 4 },
    { currentBeforeRowId: 18 },
    { currentEpoch: "epoch-2" },
    { resultEpoch: "epoch-2" },
  ])
    assert.equal(canMergeOlderPage({ ...read, ...change }), false);
});

test("duplicate page IDs dedupe and never overwrite a newly revised live window", () => {
  const live = [row(20, "new live edit"), row(21, "new reply")];
  const merged = mergeOlderRows(live, [
    row(19, "old"),
    row(19, "old"),
    row(20, "stale"),
    row(18, "history"),
  ]);
  assert.deepEqual(
    merged?.map((entry) => entry.rowId),
    [18, 19, 20, 21],
  );
  assert.equal(merged?.[2], live[0]);
  assert.equal(mergeOlderRows(merged!, [row(19, "duplicate")]), null);
});
