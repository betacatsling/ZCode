import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { probeCodexTarget } from "../src/agent-adapters/codex/codexCapabilities.js";

test(
  "Codex probe rejects a CLI build outside the pinned app-server version",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-version-probe-"));
    const executable = join(root, "codex");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdout.write('codex-cli 0.157.2\\n');\n",
      {
        mode: 0o700,
      },
    );
    t.after(() => rm(root, { recursive: true, force: true }));

    const report = await probeCodexTarget(
      {
        id: "version-probe-target",
        kind: "local",
        platform: process.platform as "darwin" | "linux" | "win32",
        available: true,
      },
      executable,
    );

    assert.deepEqual(report, {
      support: "unsupported",
      reason: "Codex CLI version does not match the pinned app-server contract",
    });
  },
);

test("Codex probe and hostManagedSupport return readable reasons when CLI is missing", async () => {
  const { createExperimentalRegistryCodexHarness } =
    await import("../src/agent-adapters/codex/createCodexHarness.js");
  const { HarnessRegistry } = await import("../src/agent-host/harnessRegistry.js");
  const missing = join("/tmp", `zcode-codex-missing-${Date.now()}`, "no-such-codex");
  const harness = createExperimentalRegistryCodexHarness({
    root: await mkdtemp(join(tmpdir(), "zcode-codex-missing-cli-")),
    registry: {
      getSnapshot: () => ({ sourceRevisions: { config: "x", account: "y" } }),
      validateSelection: () => ({ ok: true as const }),
      getProvider: () => ({
        providerId: "fake-provider",
        config: {
          access: { type: "api-key", apiKey: "unused" },
          api: { type: "openai-responses", baseUrl: "http://127.0.0.1:9/v1" },
        },
        models: [],
      }),
      getModel: () => ({ modelId: "fake-model", config: { properties: {} } }),
    } as never,
    executablePath: missing,
  });
  const registry = new HarnessRegistry();
  registry.register(harness);
  assert.equal(harness.id, "codex");
  assert.equal(harness.version, "0.157.1");
  const target = {
    id: "missing-cli-target",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
  const probe = await harness.probe(target);
  assert.equal(probe.support, "unsupported");
  assert.match(probe.reason ?? "", /Pinned Codex CLI is unavailable|not found|version check/i);
  const support = await harness.hostManagedSupport(target, {
    providerId: "fake-provider" as never,
    modelId: "fake-model" as never,
    options: { reasoningLevel: "off" },
  });
  assert.equal(support.support, "unsupported");
  assert.match(support.reason ?? "", /Pinned Codex CLI is unavailable|not found|version check/i);
  await harness.shutdown();
});
