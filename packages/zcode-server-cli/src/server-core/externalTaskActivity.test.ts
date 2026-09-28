import assert from "node:assert/strict";
import test from "node:test";
import type { AgentHostActivityIndex } from "@zcode/services";
import { loadExternalTaskActivity } from "./core.js";

test("Core reads the complete target-owned index without consulting UI workspaces", async () => {
  const expected: AgentHostActivityIndex = {
    targetId: "target-local",
    complete: true,
    sessions: [
      {
        spec: {
          schemaVersion: 1,
          hostSessionId: "archived-session",
          execution: {
            targetId: "target-local",
            workspaceIdentity: "/removed-worktree",
            worktreePath: "/removed-worktree",
          },
          harness: { id: "pi", adapterVersion: "test" },
          modelBinding: { kind: "harness-managed" },
        },
        runtimeEpoch: "epoch-1",
        sequence: 8,
        state: "busy",
        activeTurnId: "turn-1",
        pendingInteractionIds: [],
      },
    ],
  };
  let reads = 0;
  const result = await loadExternalTaskActivity({
    async listActivityIndex() {
      reads += 1;
      return expected;
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(result, expected);
});

test("an incomplete target index remains explicitly incomplete", async () => {
  const result = await loadExternalTaskActivity({
    listActivityIndex: async () => ({ targetId: "target-local", complete: false, sessions: [] }),
  });
  assert.equal(result.complete, false);
});
