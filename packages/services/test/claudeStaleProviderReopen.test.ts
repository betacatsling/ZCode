import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExecutionTarget } from "@zcode/shared/agent-host";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import type { ModelCatalogPort } from "../src/agent-host/modelBindingPlanner.js";
import { ModelBindingReconfigureRequiredError } from "../src/agent-host/modelBindingErrors.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { ClaudeHarnessAdapter } from "../src/agent-adapters/claude/claudeHarnessAdapter.js";
import { claudeAdapterHarness } from "./fixtures/claudeAdapterHarness.js";
import { fakeClaudeLauncher } from "./fixtures/claudeFakeProcess.js";
import { CLAUDE_UNIT, fakeClaudeModel } from "./fixtures/claudeUnitFixtures.js";

// A16: reopening a Claude session whose Provider was removed from the catalog refuses with the
// typed reconfigure error; it never replans onto another model, grants, or launches.
// The reopen runs on a fresh adapter (as after an app restart), so a successful attach really
// creates a grant and launches a process.

async function pinnedClaudeScript(t: test.TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-claude-pinned-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "claude");
  await writeFile(
    path,
    '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "2.1.263 (Claude Code)"; exit 0; fi\nexec cat >/dev/null\n',
    { mode: 0o700 },
  );
  return path;
}

test("open refuses a Claude session whose Provider was removed, without grant or launch", async (t) => {
  const executablePath = await pinnedClaudeScript(t);
  const h = await claudeAdapterHarness(t, { adapter: { executablePath } });
  const root = join(h.root, "host");
  await mkdir(root, { mode: 0o700 });
  const registry = new HarnessRegistry();
  registry.register(h.adapter);
  const target: ExecutionTarget = {
    id: h.spec.execution.targetId,
    kind: "local",
    platform: process.platform as ExecutionTarget["platform"],
    available: true,
  };
  let removed = false;
  const catalog: ModelCatalogPort = {
    fingerprint: h.plan.catalogFingerprint,
    validateSelection: () => (removed ? { ok: false, reason: "provider-not-found" } : { ok: true }),
  };
  const options = { root, spec: h.spec, target, catalog, registry };

  const created = await SessionHost.create(options);
  assert.equal(h.launches.length, 1);
  assert.equal(h.grants.created.length, 1);
  await created.close();
  await h.adapter.shutdown();

  const resumed = fakeClaudeLauncher();
  const adapter = new ClaudeHarnessAdapter({
    root: h.root,
    executablePath,
    targetModelGateway: h.targetModelGateway,
    modelFactory: () => fakeClaudeModel(),
    isMessagesSelection: () => true,
    fakeModelCompatibilityEvidence: (selection) => ({
      providerId: selection.providerId,
      modelId: selection.modelId,
      fixtureId: CLAUDE_UNIT.fixtureId,
    }),
    launchProcess: resumed.launchProcess,
  });
  t.after(() => adapter.shutdown());
  const resumedRegistry = new HarnessRegistry();
  resumedRegistry.register(adapter);
  const reopen = { ...options, registry: resumedRegistry };

  removed = true;
  const selection = h.plan.effective!;
  await assert.rejects(SessionHost.open(reopen), (error: unknown) => {
    assert.ok(error instanceof ModelBindingReconfigureRequiredError);
    assert.equal(error.code, "invalid-binding");
    assert.equal(error.action, "reconfigure-provider");
    assert.equal(error.reason, "provider-not-found");
    assert.equal(error.providerId, selection.providerId);
    assert.equal(error.modelId, selection.modelId);
    return true;
  });
  assert.equal(resumed.launches.length, 0, "no process is launched for the removed Provider");
  assert.equal(h.grants.created.length, 1, "no Gateway grant is created for the removed Provider");

  removed = false;
  const reopened = await SessionHost.open(reopen);
  assert.equal(reopened.binding.backendSessionId, created.binding.backendSessionId);
  assert.equal(reopened.plan.effective?.modelId, selection.modelId, "same model, no fallback");
  assert.equal(h.grants.created.length, 2, "the control reopen does grant, so the refusal is real");
  assert.equal(resumed.launches.length, 1);
  await reopened.close();
  await adapter.shutdown();
});
