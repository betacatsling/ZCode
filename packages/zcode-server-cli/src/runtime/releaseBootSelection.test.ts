import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveServerLayout } from "./paths.js";
import { currentServerTarget } from "./manifest.js";
import { hashReleaseTree } from "./immutableRelease.js";
import { createReleaseAgentWiring } from "./agentWiring.js";
import {
  registerTrustedLocalSourceBootSelection,
  verifyTrustedLocalSourceBootSelection,
} from "./releaseBootSelection.js";

const digest = (bytes: string): string => createHash("sha256").update(bytes).digest("hex");

test("old, forged, mismatched and tampered local release selections fail closed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-boot-selection-"));
  const layout = resolveServerLayout(join(dir, "install"));
  const releaseDir = join(layout.releasesDir, "local-a");
  const runtime = join(releaseDir, "runtime");
  const binaries = {
    "server-cli.js": "cli-v1",
    "server-core.js": "core-v1",
    "zcode.cjs": "agent-v1",
    node: "node-v1",
    "piWorker.js": "worker-v1",
  };
  try {
    await mkdir(runtime, { recursive: true });
    for (const [name, contents] of Object.entries(binaries))
      await writeFile(join(runtime, name), contents);
    const release = {
      version: "local-source-a",
      releaseId: "local-a",
      releaseDir,
      target: currentServerTarget(),
      archiveSha256: digest("archive-v1"),
      components: [
        {
          id: "server-runtime",
          sha256: digest("component-v1"),
          paths: ["runtime/server-cli.js"],
          sizeBytes: 6,
        },
      ],
    };
    const paths = Object.fromEntries(
      Object.entries(binaries).map(([name, value]) => [name, digest(value)]),
    ) as Record<keyof typeof binaries, string>;
    const releaseContentSha256 = await hashReleaseTree(releaseDir);
    await writeFile(
      join(releaseDir, ".release-integrity.json"),
      JSON.stringify({
        archiveSha256: release.archiveSha256,
        contentSha256: releaseContentSha256,
        target: release.target,
        version: release.version,
      }),
    );
    await assert.rejects(
      verifyTrustedLocalSourceBootSelection(layout, release),
      /selection|missing/i,
    );
    await registerTrustedLocalSourceBootSelection(layout, release, {
      protocol: "constructor-held-native-v1",
      sourceRecipe: "local-validated-source-build",
      artifactSha256: paths,
      componentSha256: { "server-runtime": digest("component-v1") },
      releaseContentSha256,
    });
    const verified = await verifyTrustedLocalSourceBootSelection(layout, release);
    assert.equal(verified.protocol, "constructor-held-native-v1");
    assert.equal(
      createReleaseAgentWiring(runtime, join(runtime, "node"), {}, verified)
        ?.ZCODE_AGENT_SERVER_BOOT_FENCE_V1,
      "1",
    );
    await assert.rejects(
      verifyTrustedLocalSourceBootSelection(layout, {
        ...release,
        archiveSha256: digest("forged"),
      }),
      /selection|mismatch/i,
    );
    await writeFile(join(runtime, "zcode.cjs"), "tampered");
    await assert.rejects(
      verifyTrustedLocalSourceBootSelection(layout, release),
      /mismatch|tamper/i,
    );
    const record = await readFile(
      join(layout.serverRoot, "trusted-local-boot-selections.json"),
      "utf8",
    );
    assert.ok(!record.includes("private-key"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
