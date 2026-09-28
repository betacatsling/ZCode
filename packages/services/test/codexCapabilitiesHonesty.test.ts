import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  codexHarnessCapabilities,
  codexHostManagedSupport,
  probeCodexTarget,
} from "../src/agent-adapters/codex/codexCapabilities.js";

const localTarget = {
  id: "local",
  kind: "local" as const,
  platform: process.platform as "darwin" | "linux" | "win32",
  available: true,
};

test("codexHarnessCapabilities locks every field support and surface-naming reason", () => {
  const caps = codexHarnessCapabilities();

  const expectedExperimental =
    "Verified only through the pinned local app-server and Fake Model control path.";

  assert.deepEqual(caps.text, { support: "experimental", reason: expectedExperimental });
  assert.deepEqual(caps.tools, { support: "experimental", reason: expectedExperimental });
  assert.deepEqual(caps.approvals, { support: "experimental", reason: expectedExperimental });
  assert.deepEqual(caps.cancelTurn, { support: "experimental", reason: expectedExperimental });
  assert.deepEqual(caps.history, { support: "experimental", reason: expectedExperimental });

  assert.equal(caps.resumeExecution.support, "unsupported");
  assert.match(caps.resumeExecution.reason ?? "", /resumeExecution/);
  assert.match(caps.resumeExecution.reason ?? "", /thread\/resume/);

  assert.equal(caps.images.support, "unsupported");
  assert.match(caps.images.reason ?? "", /images/);
  assert.notEqual(caps.images.reason, caps.resumeExecution.reason);

  assert.equal(caps.modelSwitch.support, "unsupported");
  assert.match(caps.modelSwitch.reason ?? "", /modelSwitch/);
  assert.notEqual(caps.modelSwitch.reason, caps.resumeExecution.reason);
  assert.notEqual(caps.modelSwitch.reason, caps.images.reason);

  assert.deepEqual(caps.detach, {
    support: "unsupported",
    reason: "View detach stays on the host subscription and does not stop this app-server.",
  });
  assert.deepEqual(caps.terminateSession, {
    support: "experimental",
    reason: "terminate stops only the named host session; it is not a live CLI certification.",
  });
  assert.deepEqual(caps.viewHistory, {
    support: "unsupported",
    reason: "This adapter has no read-only history snapshot and does not replay prompts.",
  });
  assert.deepEqual(caps.hostManagedModel, {
    support: "experimental",
    reason:
      "The custom provider points at an injected Gateway port, but no model execution trace has been observed.",
  });
});

test(
  "probe supported and hostManagedSupport fixture admission do not upgrade hostManagedModel",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-honesty-"));
    const executable = join(root, "codex");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdout.write('codex-cli 0.157.1\\n');\n",
      { mode: 0o700 },
    );
    await chmod(executable, 0o700);
    t.after(() => rm(root, { recursive: true, force: true }));

    const probe = await probeCodexTarget(localTarget, executable);
    assert.equal(probe.support, "supported");

    const caps = codexHarnessCapabilities();
    assert.equal(caps.hostManagedModel?.support, "experimental");
    assert.notEqual(caps.images.support, probe.support);
    assert.notEqual(caps.modelSwitch.support, probe.support);
    assert.notEqual(caps.resumeExecution.support, probe.support);

    const admitted = await codexHostManagedSupport({
      target: localTarget,
      selection: {
        providerId: "fake-provider",
        modelId: "with-fixture",
        options: { reasoningLevel: "off" },
      },
      executablePath: executable,
      adapterVersion: "0.157.1",
      isOpenAiResponsesSelection: () => true,
      fakeModelCompatibilityEvidence: (selection) =>
        selection.modelId === "with-fixture"
          ? {
              providerId: selection.providerId,
              modelId: selection.modelId,
              fixtureId: "fixture",
            }
          : undefined,
    });
    assert.equal(admitted.support, "supported");
    assert.match(admitted.reason ?? "", /Fake Model fixture evidence/);
    assert.match(admitted.reason ?? "", /no real Provider certification/i);
    assert.equal(admitted.constraints?.unifiedModelRoute, "experimental");
    assert.equal(admitted.constraints?.compatibilityEvidence, "fake-model-fixture");

    // Fixture admission must not upgrade the static capability object.
    assert.equal(codexHarnessCapabilities().hostManagedModel?.support, "experimental");
    assert.match(codexHarnessCapabilities().hostManagedModel?.reason ?? "", /model execution/);
  },
);
