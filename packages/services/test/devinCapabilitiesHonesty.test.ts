import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createExperimentalRegistryDevinHarness } from "../src/agent-adapters/devin/createDevinHarness.js";
import {
  devinHarnessCapabilities,
  devinHarnessManagedSupport,
  devinHostManagedSupport,
} from "../src/agent-adapters/devin/devinCapabilities.js";
import { probeDevinTarget } from "../src/agent-adapters/devin/devinExecutable.js";

const localTarget = {
  id: "local",
  kind: "local" as const,
  platform: process.platform as "darwin" | "linux" | "win32",
  available: true,
};

test(
  "Devin probe support does not advertise a full harness",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-devin-honesty-"));
    const executable = join(root, "devin");
    await writeFile(executable, "#!/usr/bin/env node\nprocess.stdout.write('devin 0.0.1\\n');\n", {
      mode: 0o700,
    });
    await chmod(executable, 0o700);
    t.after(() => rm(root, { recursive: true, force: true }));

    const probe = await probeDevinTarget(localTarget, executable);
    assert.equal(probe.support, "supported");
    assert.match(probe.reason ?? "", /print mode/i);
    assert.match(probe.reason ?? "", /-p/);
    assert.match(probe.reason ?? "", /does not certify/i);

    const managed = await devinHarnessManagedSupport({
      target: localTarget,
      executablePath: executable,
    });
    assert.equal(managed.support, "supported");
    assert.equal(managed.reason, probe.reason);

    const hostManaged = await devinHostManagedSupport({
      target: localTarget,
      executablePath: executable,
      selection: { providerId: "devin", modelId: "default" },
    });
    assert.equal(hostManaged.support, "unsupported");
    assert.match(hostManaged.reason ?? "", /Host-managed/i);
    assert.match(hostManaged.reason ?? "", /probe/i);

    const harness = createExperimentalRegistryDevinHarness({ root, executablePath: executable });
    const reported = await harness.capabilities(localTarget);
    assert.deepEqual(reported, devinHarnessCapabilities());
    assert.notEqual(reported.tools.support, probe.support);
    assert.notEqual(reported.resumeExecution.support, probe.support);
    assert.notEqual(reported.images.support, probe.support);
    assert.notEqual(reported.modelSwitch.support, probe.support);

    await assert.rejects(
      () =>
        harness.resolveInteraction({
          type: "resolveInteraction",
          commandId: "cmd-resolve",
          hostSessionId: "devin-honesty",
          runtimeEpoch: "epoch-1",
          turnId: "turn-1",
          interactionId: "interaction-1",
          decision: "allow",
        }),
      /print mode/,
    );
  },
);
