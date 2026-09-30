import assert from "node:assert/strict";
import test from "node:test";
import { harnessManifestSchema, resolveHarnessIcon } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import {
  CLAUDE_CODE_HARNESS_MANIFEST,
  CODEX_HARNESS_MANIFEST,
  createHarnessDirectory,
  createHostHarnessDirectory,
  DEFAULT_HOST_HARNESS_MANIFESTS,
  DEVIN_HARNESS_MANIFEST,
  NATIVE_ZCODE_HARNESS_MANIFEST,
  PI_HARNESS_MANIFEST,
} from "../src/agent-host/harnessDirectory.js";
import { MockHarness } from "../src/agent-host/mockHarness.js";

function manifest(input: { id: string; name: string; adapterVersion: string; icon?: object }) {
  return harnessManifestSchema.parse({ schemaVersion: 1, ...input });
}

test("directory manifests accept only static asset IDs and resolve safe fallback icons", () => {
  const trusted = manifest({
    id: "mock",
    name: "Mock Harness",
    adapterVersion: "1.0.0",
    icon: {
      lightAssetId: "mock-light",
      darkAssetId: "mock-dark",
      fallback: "initials",
    },
  });
  assert.deepEqual(resolveHarnessIcon(trusted, "light"), {
    kind: "asset",
    assetId: "mock-light",
  });
  assert.deepEqual(resolveHarnessIcon(trusted, "dark"), {
    kind: "asset",
    assetId: "mock-dark",
  });
  assert.deepEqual(resolveHarnessIcon(undefined, "light"), {
    kind: "fallback",
    fallback: "generic",
  });
  assert.equal(
    harnessManifestSchema.safeParse({
      schemaVersion: 1,
      id: "mock",
      name: "Mock",
      adapterVersion: "1.0.0",
      icon: { lightAssetId: "https://example.test/logo.svg" },
    }).success,
    false,
  );
  assert.equal(
    harnessManifestSchema.safeParse({
      schemaVersion: 1,
      id: "mock",
      name: "Mock",
      adapterVersion: "1.0.0",
      icon: { lightAssetId: "../outside" },
    }).success,
    false,
  );
});

test("directory derives display metadata from trusted manifests and existing registry", () => {
  const registry = new HarnessRegistry();
  registry.register(new MockHarness());
  const directory = createHarnessDirectory({
    registry,
    manifests: [
      manifest({
        id: "mock",
        name: "Mock Harness",
        adapterVersion: "1.0.0",
        icon: { lightAssetId: "mock-light" },
      }),
      manifest({ id: "pi", name: "Pi", adapterVersion: "0.87.1" }),
    ],
  });

  assert.deepEqual(
    directory.list().map((entry) => [entry.manifest.id, entry.status]),
    [
      ["mock", "registered"],
      ["pi", "unavailable"],
    ],
  );
  assert.equal(directory.get("mock")?.manifest.name, "Mock Harness");
  assert.equal(directory.get("pi")?.status, "unavailable");
  assert.equal(directory.get("missing"), undefined);
  assert.equal(Object.isFrozen(directory.get("mock")?.manifest), true);
});

test("directory rejects duplicate manifests and registry version mismatches", () => {
  const registry = new HarnessRegistry();
  registry.register(new MockHarness());
  const duplicate = manifest({ id: "mock", name: "Mock", adapterVersion: "1.0.0" });
  assert.throws(
    () => createHarnessDirectory({ registry, manifests: [duplicate, duplicate] }),
    /duplicate.*manifest/i,
  );
  assert.throws(
    () =>
      createHarnessDirectory({
        registry,
        manifests: [manifest({ id: "mock", name: "Mock", adapterVersion: "2.0.0" })],
      }),
    /version.*mismatch/i,
  );
});

test("registered adapters without manifests are not invented into the directory", () => {
  const registry = new HarnessRegistry();
  registry.register(new MockHarness());
  const directory = createHarnessDirectory({ registry, manifests: [] });
  assert.deepEqual(directory.list(), []);
  assert.equal(directory.get("mock"), undefined);
});

test("default host directory lists zcode, pi, codex, claude-code, and devin manifests", () => {
  const registry = new HarnessRegistry();
  registry.register(new MockHarness());
  const directory = createHostHarnessDirectory({ registry });
  assert.deepEqual(
    directory.list().map((entry) => [entry.manifest.id, entry.status, entry.source]),
    [
      ["zcode", "registered", "native"],
      ["pi", "unavailable", "external"],
      ["codex", "unavailable", "external"],
      ["claude-code", "unavailable", "external"],
      ["devin", "unavailable", "external"],
    ],
  );
  assert.equal(
    directory.get("codex")?.manifest.adapterVersion,
    CODEX_HARNESS_MANIFEST.adapterVersion,
  );
  assert.equal(
    directory.get("claude-code")?.manifest.adapterVersion,
    CLAUDE_CODE_HARNESS_MANIFEST.adapterVersion,
  );
  assert.equal(directory.get("devin")?.manifest.name, DEVIN_HARNESS_MANIFEST.name);
  assert.equal(directory.get("mock"), undefined);
  assert.deepEqual(
    DEFAULT_HOST_HARNESS_MANIFESTS.map((entry) => entry.id),
    [
      NATIVE_ZCODE_HARNESS_MANIFEST.id,
      PI_HARNESS_MANIFEST.id,
      CODEX_HARNESS_MANIFEST.id,
      CLAUDE_CODE_HARNESS_MANIFEST.id,
      DEVIN_HARNESS_MANIFEST.id,
    ],
  );
});
