import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderRegistryService } from "@zcode/provider";
import { isMultiHarnessNewSessionAdmissionEnabled } from "@zcode/shared/agent-host";
import {
  CODEX_HARNESS_MANIFEST,
  PI_HARNESS_MANIFEST,
} from "../src/agent-host/harnessDirectory.js";
import { createLazyTargetAgentHostService } from "../src/agent-host/lazyTargetService.js";

/**
 * Cross-contract: production wires `allowNewSessions` through
 * `isMultiHarnessNewSessionAdmissionEnabled`. Pi/Codex must follow that flag
 * (exact `"1"` only), not loose truthiness.
 */
function fakeProviderRegistry(): ProviderRegistryService {
  return {
    start: async () => undefined,
    getProvider: () => undefined,
    validateSelection: () => ({ ok: false, reason: "fixture" }),
  } as unknown as ProviderRegistryService;
}

function localTarget() {
  return {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available: true,
  };
}

async function withLazyHost(
  env: NodeJS.ProcessEnv | Record<string, string | undefined>,
  run: (service: ReturnType<typeof createLazyTargetAgentHostService>["service"]) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "zcode-mh-pi-codex-"));
  const { service, dispose } = createLazyTargetAgentHostService({
    root,
    target: localTarget(),
    registry: fakeProviderRegistry(),
    allowNewSessions: () => isMultiHarnessNewSessionAdmissionEnabled(env),
    nativeOwner: {
      createWorkspaceSession: async () => {
        throw new Error("native-not-used");
      },
    } as never,
  });
  try {
    await run(service);
  } finally {
    await dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("MULTI_HARNESS flag off keeps Pi and Codex unavailable for new sessions", async () => {
  for (const env of [
    {},
    { ZCODE_MULTI_HARNESS_ENABLED: "0" },
    { ZCODE_MULTI_HARNESS_ENABLED: "true" },
    { ZCODE_MULTI_HARNESS_ENABLED: "1 " },
  ] as const) {
    assert.equal(isMultiHarnessNewSessionAdmissionEnabled(env), false);
    await withLazyHost(env, async (service) => {
      const availability = await service.getAvailability();
      // nativeOwner keeps Host admissionEnabled; flag only gates *external* new sessions.
      assert.equal(availability.admissionEnabled, true);
      assert.equal(availability.harnesses.includes("pi"), false);
      assert.equal(availability.harnesses.includes("codex"), false);
      assert.deepEqual(availability.harnesses, ["zcode"]);

      await assert.rejects(
        () => service.create({} as never),
        /new external sessions disabled/,
      );

      const directory = await service.getDirectory();
      assert.equal(directory.entries.find((e) => e.manifest.id === "pi")?.status, "unavailable");
      assert.equal(directory.entries.find((e) => e.manifest.id === "codex")?.status, "unavailable");
      assert.equal(
        directory.entries.find((e) => e.manifest.id === "claude-code")?.status,
        "unavailable",
      );
      assert.equal(directory.entries.find((e) => e.manifest.id === "devin")?.status, "unavailable");
    });
  }
});

test("MULTI_HARNESS flag exact 1 admits Pi and Codex on lazy directory", async () => {
  const env = { ZCODE_MULTI_HARNESS_ENABLED: "1" };
  assert.equal(isMultiHarnessNewSessionAdmissionEnabled(env), true);
  await withLazyHost(env, async (service) => {
    const availability = await service.getAvailability();
    assert.equal(availability.admissionEnabled, true);
    assert.ok(availability.harnesses.includes("pi"));
    assert.ok(availability.harnesses.includes("codex"));
    // Flag gates all lazy externals; Pi/Codex are not a special subset.
    assert.ok(availability.harnesses.includes("claude-code"));
    assert.ok(availability.harnesses.includes("devin"));
    // ACP second agents stay opt-in — MULTI_HARNESS does not admit them.
    assert.equal(availability.harnesses.includes("opencode"), false);
    assert.equal(availability.harnesses.includes("goose"), false);

    const directory = await service.getDirectory();
    const pi = directory.entries.find((e) => e.manifest.id === "pi");
    const codex = directory.entries.find((e) => e.manifest.id === "codex");
    assert.equal(pi?.status, "registered");
    assert.equal(codex?.status, "registered");
    assert.equal(pi?.manifest.adapterVersion, PI_HARNESS_MANIFEST.adapterVersion);
    assert.equal(codex?.manifest.adapterVersion, CODEX_HARNESS_MANIFEST.adapterVersion);
    assert.equal(
      directory.entries.find((e) => e.manifest.id === "claude-code")?.status,
      "registered",
    );
    assert.equal(directory.entries.find((e) => e.manifest.id === "devin")?.status, "registered");
    assert.equal(
      directory.entries.some((e) => e.manifest.id === "opencode" || e.manifest.id === "goose"),
      false,
    );
  });
});
