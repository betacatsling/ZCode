import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProviderRegistryService } from "@zcode/provider";
import {
  CLAUDE_CODE_HARNESS_MANIFEST,
  CODEX_HARNESS_MANIFEST,
  DEVIN_HARNESS_MANIFEST,
  NATIVE_ZCODE_HARNESS_MANIFEST,
  PI_HARNESS_MANIFEST,
} from "../src/agent-host/harnessDirectory.js";
import { createLazyTargetAgentHostService } from "../src/agent-host/lazyTargetService.js";

const EXPECTED_EXTERNAL = ["pi", "codex", "claude-code", "devin"] as const;
const EXPECTED_FULL = ["zcode", ...EXPECTED_EXTERNAL] as const;

function fakeProviderRegistry(): ProviderRegistryService {
  return {
    start: async () => undefined,
    getProvider: () => undefined,
    validateSelection: () => ({ ok: false, reason: "fixture" }),
  } as unknown as ProviderRegistryService;
}

function localTarget(available = true) {
  return {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux" | "win32",
    available,
  };
}

test("lazy getAvailability / getDirectory expose zcode+pi+codex+claude-code+devin when admission is on", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-lazy-admission-"));
  const { service, dispose } = createLazyTargetAgentHostService({
    root,
    target: localTarget(true),
    registry: fakeProviderRegistry(),
    allowNewSessions: () => true,
    nativeOwner: {
      createWorkspaceSession: async () => {
        throw new Error("native-not-used");
      },
    } as never,
  });
  try {
    const availability = await service.getAvailability();
    assert.deepEqual(availability.harnesses, [...EXPECTED_FULL]);
    assert.equal(availability.admissionEnabled, true);

    const directory = await service.getDirectory();
    assert.deepEqual(
      directory.entries.map((entry) => [entry.manifest.id, entry.status, entry.source]),
      [
        ["zcode", "registered", "native"],
        ["pi", "registered", "external"],
        ["codex", "registered", "external"],
        ["claude-code", "registered", "external"],
        ["devin", "registered", "external"],
      ],
    );
    assert.equal(
      directory.entries.find((e) => e.manifest.id === "zcode")?.manifest.adapterVersion,
      NATIVE_ZCODE_HARNESS_MANIFEST.adapterVersion,
    );
    assert.equal(
      directory.entries.find((e) => e.manifest.id === "pi")?.manifest.adapterVersion,
      PI_HARNESS_MANIFEST.adapterVersion,
    );
    assert.equal(
      directory.entries.find((e) => e.manifest.id === "codex")?.manifest.adapterVersion,
      CODEX_HARNESS_MANIFEST.adapterVersion,
    );
    assert.equal(
      directory.entries.find((e) => e.manifest.id === "claude-code")?.manifest.adapterVersion,
      CLAUDE_CODE_HARNESS_MANIFEST.adapterVersion,
    );
    assert.equal(
      directory.entries.find((e) => e.manifest.id === "devin")?.manifest.adapterVersion,
      DEVIN_HARNESS_MANIFEST.adapterVersion,
    );
  } finally {
    await dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("lazy cold directory marks external harnesses unavailable when new sessions are disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-lazy-admission-off-"));
  const { service, dispose } = createLazyTargetAgentHostService({
    root,
    target: localTarget(true),
    registry: fakeProviderRegistry(),
    allowNewSessions: () => false,
    nativeOwner: {
      createWorkspaceSession: async () => {
        throw new Error("native-not-used");
      },
    } as never,
  });
  try {
    const availability = await service.getAvailability();
    assert.deepEqual(availability.harnesses, ["zcode"]);

    const directory = await service.getDirectory();
    assert.deepEqual(
      directory.entries.map((entry) => [entry.manifest.id, entry.status]),
      [
        ["zcode", "registered"],
        ["pi", "unavailable"],
        ["codex", "unavailable"],
        ["claude-code", "unavailable"],
        ["devin", "unavailable"],
      ],
    );
  } finally {
    await dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("lazy warm path registers pi/codex/claude-code/devin without version mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-lazy-warm-"));
  const { service, dispose } = createLazyTargetAgentHostService({
    root,
    target: localTarget(true),
    registry: fakeProviderRegistry(),
    allowNewSessions: () => true,
  });
  try {
    // Forces getTarget() → lazy register of all external factories.
    const capability = await service.getWorkspaceSessionCapability({
      harnessId: "devin",
      modelBinding: { kind: "harness-managed" },
    });
    assert.equal(capability.targetId, "local");
    assert.ok(
      capability.report.support === "unsupported" || capability.report.support === "experimental",
      `expected unsupported/experimental without Devin CLI, got ${capability.report.support}`,
    );

    const directory = await service.getDirectory();
    assert.deepEqual(
      directory.entries.map((entry) => entry.manifest.id),
      [...EXPECTED_FULL],
    );
    for (const id of EXPECTED_EXTERNAL) {
      assert.equal(
        directory.entries.find((entry) => entry.manifest.id === id)?.status,
        "registered",
        id,
      );
    }
  } finally {
    await dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("lazy getDirectory keeps all five entries when target is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-lazy-target-down-"));
  const { service, dispose } = createLazyTargetAgentHostService({
    root,
    target: localTarget(false),
    registry: fakeProviderRegistry(),
    allowNewSessions: () => true,
    nativeOwner: {
      createWorkspaceSession: async () => {
        throw new Error("native-not-used");
      },
    } as never,
  });
  try {
    const directory = await service.getDirectory();
    assert.equal(directory.status, "unavailable");
    assert.deepEqual(
      directory.entries.map((entry) => [entry.manifest.id, entry.status]),
      [
        ["zcode", "unavailable"],
        ["pi", "unavailable"],
        ["codex", "unavailable"],
        ["claude-code", "unavailable"],
        ["devin", "unavailable"],
      ],
    );
  } finally {
    await dispose();
    await rm(root, { recursive: true, force: true });
  }
});
