import assert from "node:assert/strict";
import { test } from "node:test";
import { createHostDatabaseStartup } from "./hostDatabaseStartup.js";

test("Core attachment startup skips native database preparation without a local workspace", async () => {
  const phases: string[] = [];
  let initialized = 0;
  const startup = createHostDatabaseStartup({
    cwd: "/no-local-workspace-is-required-for-a-core-attachment",
    workingDirectories: ["/no-local-workspace-is-required-for-a-core-attachment"],
    skipStoragePreparation: true,
    publish: (state) => {
      phases.push(state.phase);
    },
    initializeServices: async () => {
      initialized++;
    },
    onFailure: (error) => {
      throw error;
    },
  });
  try {
    await startup.coordinator.start();
    assert.equal(initialized, 1);
    assert.equal(startup.coordinator.snapshot.phase, "ready");
    assert(!phases.includes("preparing_host_storage"));
    assert(!phases.includes("preparing_session_storage"));
  } finally {
    startup.dispose();
  }
});
