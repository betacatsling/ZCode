import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createReleaseAgentWiring, resolveBundledAgentWiring } from "./agentWiring.js";

test("only source-bound release wiring requests strict native storage startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-wiring-"));
  try {
    const bundle = join(dir, "zcode.cjs");
    await writeFile(bundle, "// path selection only, not a process fixture\n");
    const release = createReleaseAgentWiring(dir, process.execPath, {});
    assert.equal(release?.ZCODE_AGENT_SERVER_REQUIRES_STORAGE_STARTUP, "1");
    assert.equal(release?.ZCODE_AGENT_SERVER_BOOT_FENCE_V1, undefined);
    assert.equal(
      createReleaseAgentWiring(dir, process.execPath, {
        ZCODE_AGENT_SERVER_BOOT_FENCE_V1: "1",
      })?.ZCODE_AGENT_SERVER_BOOT_FENCE_V1,
      undefined,
      "inherited env alone cannot grant a release boot capability",
    );
    assert.deepEqual(JSON.parse(release!.ZCODE_AGENT_SERVER_ARGS_JSON), [
      bundle,
      "app-server",
      "--stdio",
    ]);
    assert.equal(
      createReleaseAgentWiring(dir, process.execPath, { ZCODE_AGENT_SERVER_COMMAND: "/custom" }),
      null,
    );
    const built = await resolveBundledAgentWiring(dir, {});
    assert.equal(built?.ZCODE_AGENT_SERVER_REQUIRES_STORAGE_STARTUP, "1");
    assert.equal(
      await resolveBundledAgentWiring(dir, { ZCODE_AGENT_SERVER_COMMAND: "/custom" }),
      null,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
