import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  claudeHarnessCapabilities,
  claudeHostManagedSupport,
} from "../src/agent-adapters/claude/claudeCapabilities.js";
import { probeClaudeTarget } from "../src/agent-adapters/claude/claudeExecutable.js";

const localTarget = {
  id: "local",
  kind: "local" as const,
  platform: process.platform as "darwin" | "linux" | "win32",
  available: true,
};

const PINNED_FAKE_MODEL_ONLY =
  "Verified only through the pinned Claude Code CLI 2.1.263 and a loopback FakeModel.";

const REQUIRED_FIELDS = [
  "text",
  "tools",
  "approvals",
  "cancelTurn",
  "history",
  "resumeExecution",
  "images",
  "modelSwitch",
] as const;

test("claudeHarnessCapabilities locks every field support and surface-naming reason", () => {
  const caps = claudeHarnessCapabilities();

  assert.deepEqual([...REQUIRED_FIELDS].sort(), Object.keys(caps).sort());
  assert.equal(caps.detach, undefined);
  assert.equal(caps.terminateSession, undefined);
  assert.equal(caps.viewHistory, undefined);
  assert.equal(caps.hostManagedModel, undefined);

  assert.deepEqual(caps.text, { support: "experimental", reason: PINNED_FAKE_MODEL_ONLY });
  assert.deepEqual(caps.tools, { support: "experimental", reason: PINNED_FAKE_MODEL_ONLY });
  assert.deepEqual(caps.approvals, { support: "experimental", reason: PINNED_FAKE_MODEL_ONLY });
  assert.deepEqual(caps.cancelTurn, { support: "experimental", reason: PINNED_FAKE_MODEL_ONLY });
  assert.deepEqual(caps.history, { support: "experimental", reason: PINNED_FAKE_MODEL_ONLY });
  assert.match(caps.text.reason ?? "", /pinned Claude Code CLI/);
  assert.match(caps.text.reason ?? "", /loopback FakeModel/);

  assert.deepEqual(caps.resumeExecution, {
    support: "unsupported",
    reason:
      "Cold attach and the opaque native session_id resume saved history only; uncertain in-flight turns are never replayed by Host resumeExecution.",
  });
  assert.match(caps.resumeExecution.reason ?? "", /resumeExecution/);
  assert.match(caps.resumeExecution.reason ?? "", /session_id/);

  assert.equal(caps.images.support, "unsupported");
  assert.match(caps.images.reason ?? "", /images/);
  assert.notEqual(caps.images.reason, caps.resumeExecution.reason);

  assert.equal(caps.modelSwitch.support, "unsupported");
  assert.match(caps.modelSwitch.reason ?? "", /modelSwitch/);
  assert.notEqual(caps.modelSwitch.reason, caps.resumeExecution.reason);
  assert.notEqual(caps.modelSwitch.reason, caps.images.reason);
});

test(
  "probe supported and hostManagedSupport fixture admission do not upgrade Claude capabilities",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-claude-honesty-"));
    const executable = join(root, "claude");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('2.1.263\\n');\n", {
      mode: 0o700,
    });
    await chmod(executable, 0o700);
    t.after(() => rm(root, { recursive: true, force: true }));

    const probe = await probeClaudeTarget(localTarget, executable);
    assert.equal(probe.support, "supported");
    assert.match(probe.reason ?? "", /version probe/);
    assert.match(probe.reason ?? "", /does not certify/);
    for (const named of [
      "tools",
      "approvals",
      "history",
      "resumeExecution",
      "images",
      "modelSwitch",
    ]) {
      assert.match(probe.reason ?? "", new RegExp(named));
    }

    const caps = claudeHarnessCapabilities();
    assert.equal(caps.text.support, "experimental");
    assert.notEqual(caps.tools.support, probe.support);
    assert.notEqual(caps.approvals.support, probe.support);
    assert.notEqual(caps.history.support, probe.support);
    assert.notEqual(caps.resumeExecution.support, probe.support);
    assert.notEqual(caps.images.support, probe.support);
    assert.notEqual(caps.modelSwitch.support, probe.support);
    assert.equal(caps.hostManagedModel, undefined);

    const selection = {
      providerId: "fake-provider",
      modelId: "with-fixture",
      options: { reasoningLevel: "low" },
    };
    const admitted = await claudeHostManagedSupport({
      target: localTarget,
      selection,
      executablePath: executable,
      isMessagesSelection: () => true,
      fakeModelCompatibilityEvidence: (candidate) =>
        candidate.modelId === "with-fixture"
          ? {
              providerId: candidate.providerId,
              modelId: candidate.modelId,
              fixtureId: "fixture",
            }
          : undefined,
    });
    assert.equal(admitted.support, "supported");
    assert.match(admitted.reason ?? "", /FakeModel/);
    assert.equal(admitted.constraints?.compatibilityEvidence, "fake-model-fixture");
    assert.equal(admitted.constraints?.apiFormat, "anthropic-messages");

    const afterFixture = claudeHarnessCapabilities();
    assert.deepEqual(afterFixture, caps);
    assert.equal(afterFixture.hostManagedModel, undefined);
    assert.notEqual(afterFixture.text.support, admitted.support);
    assert.notEqual(afterFixture.resumeExecution.support, admitted.support);
    assert.notEqual(afterFixture.images.support, admitted.support);
    assert.notEqual(afterFixture.modelSwitch.support, admitted.support);

    const experimental = await claudeHostManagedSupport({
      target: localTarget,
      selection: {
        providerId: "fake-provider",
        modelId: "no-fixture",
        options: { reasoningLevel: "medium" },
      },
      executablePath: executable,
      isMessagesSelection: () => true,
    });
    assert.equal(experimental.support, "experimental");
    assert.equal(claudeHarnessCapabilities().hostManagedModel, undefined);
    assert.equal(claudeHarnessCapabilities().images.support, "unsupported");
  },
);
