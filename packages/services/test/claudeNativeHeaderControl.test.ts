import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const run = promisify(execFile);

type Probe = {
  sdkVersion: string;
  bundledVersion: string;
  nativeVersion?: string;
  nativeSuccess: boolean;
  beta: string[];
  betaHeaderPresent: boolean;
  path: string;
  thinkingType?: string;
  hasDeferredToolShape: boolean;
  hasContextManagement: boolean;
  probeHeader?: string;
  requests: number;
  error?: string;
};

// The fake endpoint records the raw native request, not Gateway ingress or a rewritten proxy request.
test(
  "pinned Claude custom header empty value cannot be assumed to suppress native beta",
  { timeout: 200000 },
  async () => {
    const observations: Probe[] = [];
    for (const mode of ["baseline", "marker", "empty"] as const) {
      const { stdout } = await run(
        process.execPath,
        ["packages/services/test/fixtures/probeClaudeNativeHeaders.mjs"],
        {
          env: { PATH: process.env.PATH ?? "", ZCODE_CLAUDE_HEADER_PROBE: mode },
          timeout: 60000,
        },
      );
      const probe = JSON.parse(stdout) as Probe;
      assert.equal(probe.sdkVersion, "0.3.263");
      assert.equal(probe.bundledVersion, "2.1.263");
      assert.equal(probe.nativeVersion, "2.1.263");
      assert.equal(probe.nativeSuccess, true, `${mode}: real native result required`);
      assert.equal(probe.requests, 1, `${mode}: exactly one native fake request`);
      assert.equal(probe.error, undefined, `${mode}: ${probe.error ?? ""}`);
      assert.equal(probe.path, "/v1/messages?beta=true");
      assert.equal(
        probe.betaHeaderPresent,
        true,
        `${mode}: empty custom value must not hide the native beta header`,
      );
      assert.equal(probe.thinkingType, "disabled");
      assert.equal(probe.hasDeferredToolShape, false);
      assert.equal(probe.hasContextManagement, false);
      assert.equal(probe.probeHeader, mode === "marker" ? "on" : undefined);
      observations.push(probe);
    }
    assert.deepEqual(observations[0]?.beta, [
      "claude-code-20250219",
      "effort-2025-11-24",
      "interleaved-thinking-2025-05-14",
    ]);
    // Contract: if native CLI itself does not emit beta, only then can a separate Gateway trial begin.
    // This assertion deliberately records the pinned negative evidence; change only after a reviewed version bump.
    assert.deepEqual(observations[1]?.beta, observations[0]?.beta);
    assert.deepEqual(observations[2]?.beta, observations[0]?.beta);
  },
);
