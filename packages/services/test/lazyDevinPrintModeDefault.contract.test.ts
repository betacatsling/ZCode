/**
 * P6 contract — lazy Host default Devin path stays print-mode, not ACP.
 *
 * Tip ledger: lazyTargetService registers createExperimentalRegistryDevinHarness only.
 * Optional ACP Devin lives under agent-adapters/acp and must not be the lazy default.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const lazySrc = join(here, "../src/agent-host/lazyTargetService.ts");

test("lazyTargetService wires print-mode Devin factory, not ACP Devin", () => {
  const src = readFileSync(lazySrc, "utf8");
  assert.match(src, /createExperimentalRegistryDevinHarness/);
  assert.match(src, /agent-adapters\/devin\/createDevinHarness\.js/);
  assert.doesNotMatch(src, /createAcpHarness/);
  assert.doesNotMatch(src, /agent-adapters\/acp/);
  assert.doesNotMatch(src, /acp\/agents\/devin/);
  assert.doesNotMatch(src, /["']devin acp["']/);
});
