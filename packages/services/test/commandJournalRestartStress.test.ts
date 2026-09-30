import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CommandJournal } from "../src/agent-host/commandJournal.js";

const ITERATIONS = 40;
const identity = {
  targetId: "local-a",
  workspaceIdentity: "workspace-a",
  harnessId: "pi",
  hostSessionId: "host-a",
  runtimeEpoch: "epoch-a",
};

test("假传输重启多次后不确定的 prompt 不会被再次接受", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-journal-stress-"));
  try {
    const command = {
      type: "send" as const,
      commandId: "cmd-stress",
      hostSessionId: "host-a",
      turnId: "turn-1",
      text: "do not replay this prompt",
    };
    let journal = await CommandJournal.open(root, identity);
    assert.equal((await journal.accept(command)).status, "accepted");
    for (let i = 0; i < ITERATIONS; i += 1) {
      await journal.close();
      journal = await CommandJournal.open(root, identity);
      assert.equal(journal.query(command.commandId)?.status, "execution-unknown");
      assert.equal((await journal.accept(command)).status, "duplicate");
      assert.equal(journal.query(command.commandId)?.status, "execution-unknown");
    }
    await journal.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
