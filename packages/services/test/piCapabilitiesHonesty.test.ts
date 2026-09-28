import assert from "node:assert/strict";
import test from "node:test";
import type { ExecutionTarget } from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import {
  piControlPlaneCapabilities,
  piHarnessCapabilities,
} from "../src/agent-adapters/pi/piCapabilities.js";
import { PiAdapter } from "../src/agent-adapters/pi/piAdapter.js";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";

const localTarget: ExecutionTarget = {
  id: "local",
  kind: "local",
  platform: process.platform as ExecutionTarget["platform"],
  available: true,
};

const selection = (reasoningLevel: string): ModelSelection => ({
  providerId: "provider-a",
  modelId: "model-a",
  options: { reasoningLevel },
});

const HARNESS_FIELDS = [
  "text",
  "tools",
  "approvals",
  "cancelTurn",
  "history",
  "resumeExecution",
  "images",
  "modelSwitch",
] as const;

const UNSUPPORTED = ["resumeExecution", "images", "modelSwitch"] as const;

function harnessAdapter(): PiHarnessAdapter {
  return new PiHarnessAdapter({
    root: "/tmp/pi-honesty-unused",
    modelFactory: () => {
      throw new Error("model factory must not run for capability honesty");
    },
  });
}

function controlAdapter(): PiAdapter {
  return new PiAdapter({
    planner: {
      plan: async () => {
        throw new Error("planner must not run for capability honesty");
      },
    },
    transportFactory: () => {
      throw new Error("transport must not run for capability honesty");
    },
  });
}

test("Pi harness capabilities stay honest on every field", () => {
  const caps = piHarnessCapabilities();
  assert.deepEqual([...HARNESS_FIELDS].sort(), Object.keys(caps).sort());
  assert.equal(caps.detach, undefined);
  assert.equal(caps.terminateSession, undefined);
  assert.equal(caps.viewHistory, undefined);
  assert.equal(caps.hostManagedModel, undefined);

  assert.equal(caps.text.support, "supported");
  assert.match(caps.text.reason ?? "", /text turns/);
  assert.match(caps.text.reason ?? "", /images/);
  assert.match(caps.text.reason ?? "", /modelSwitch/);

  assert.equal(caps.tools.support, "supported");
  assert.deepEqual(caps.tools.constraints, { read: true, write: true, edit: true, bash: true });
  assert.match(caps.tools.reason ?? "", /read, write, edit, and bash/);
  assert.doesNotMatch(caps.tools.reason ?? "", /\bexec\b/);

  assert.equal(caps.approvals.support, "supported");
  assert.match(caps.approvals.reason ?? "", /write, edit, and bash/);
  assert.match(caps.approvals.reason ?? "", /read may run unattended/);

  assert.equal(caps.cancelTurn.support, "supported");
  assert.match(caps.cancelTurn.reason ?? "", /cancelTurn/);
  assert.match(caps.cancelTurn.reason ?? "", /active Pi worker turn/);

  assert.equal(caps.history.support, "supported");
  assert.match(caps.history.reason ?? "", /native session file/);
  assert.match(caps.history.reason ?? "", /resumeExecution/);

  for (const field of UNSUPPORTED) {
    assert.equal(caps[field].support, "unsupported", field);
    assert.equal(caps[field].reason, caps.resumeExecution.reason);
    for (const named of UNSUPPORTED) {
      assert.match(caps[field].reason ?? "", new RegExp(named), field);
    }
    assert.match(caps[field].reason ?? "", /probe/);
    assert.match(caps[field].reason ?? "", /hostManagedSupport/);
    assert.match(caps[field].reason ?? "", /does not upgrade/);
  }
});

test(
  "Pi harness probe and hostManagedSupport do not upgrade unsupported fields",
  { skip: process.platform !== "darwin" && process.platform !== "linux" },
  async () => {
    const adapter = harnessAdapter();
    const caps = await adapter.capabilities(localTarget);
    assert.deepEqual(caps, piHarnessCapabilities());

    const probe = await adapter.probe(localTarget);
    assert.equal(probe.support, "supported");
    assert.match(probe.reason ?? "", /macOS or Linux/);
    assert.match(probe.reason ?? "", /this process platform/);
    assert.match(probe.reason ?? "", /does not certify/);
    for (const named of UNSUPPORTED) assert.match(probe.reason ?? "", new RegExp(named));

    for (const level of ["off", "low"] as const) {
      const managed = await adapter.hostManagedSupport(localTarget, selection(level));
      assert.equal(managed.support, "supported", level);
      assert.match(managed.reason ?? "", /reasoningLevel off or low/);
      assert.match(managed.reason ?? "", /does not certify/);
      for (const named of UNSUPPORTED) assert.match(managed.reason ?? "", new RegExp(named));
      assert.notEqual(caps.resumeExecution.support, managed.support);
      assert.notEqual(caps.images.support, managed.support);
      assert.notEqual(caps.modelSwitch.support, managed.support);
      assert.notEqual(caps.resumeExecution.support, probe.support);
    }

    const rejected = await adapter.hostManagedSupport(localTarget, selection("high"));
    assert.equal(rejected.support, "unsupported");
    assert.match(rejected.reason ?? "", /reasoningLevel=off or low/);
    assert.match(rejected.reason ?? "", /does not certify/);
    const missing = await adapter.hostManagedSupport(localTarget, {
      providerId: "provider-a",
      modelId: "model-a",
    });
    assert.equal(missing.support, "unsupported");
    assert.match(missing.reason ?? "", /reasoningLevel=off or low/);

    const remote = await adapter.probe({ ...localTarget, platform: "win32", id: "win" });
    assert.equal(remote.support, "unsupported");
    assert.match(remote.reason ?? "", /macOS and Linux/);
    assert.deepEqual(await adapter.capabilities(localTarget), caps);
  },
);

test("Pi control plane capabilities stay distinct from the worker tool set", async () => {
  const adapter = controlAdapter();
  const report = await adapter.capabilities({
    id: "local-1",
    kind: "local",
    platform: "linux",
    available: true,
  });
  assert.deepEqual(report, piControlPlaneCapabilities(adapter.hostManagedRoute));
  assert.deepEqual(report.tools.constraints, { read: true, write: true, exec: true });
  assert.doesNotMatch(report.tools.reason ?? "", /bash/);
  assert.equal(report.hostManagedModel?.support, "experimental");
  assert.notEqual(report.hostManagedModel?.support, "supported");
  for (const field of UNSUPPORTED) {
    assert.equal(report[field].support, "unsupported", field);
    assert.match(report[field].reason ?? "", /does not upgrade/);
  }
  const probe = await adapter.probe({
    id: "local-1",
    kind: "local",
    platform: "linux",
    available: true,
  });
  assert.equal(probe.support, "supported");
  assert.notEqual(report.images.support, probe.support);
  const managed = await adapter.hostManagedSupport(
    { id: "local-1", kind: "local", platform: "linux", available: true },
    selection("off"),
  );
  assert.equal(managed.support, "experimental");
  assert.notEqual(report.resumeExecution.support, managed.support);
  assert.match(managed.reason ?? "", /does not call Model\.streamText|Model\.streamText/);
  assert.match(managed.reason ?? "", /does not certify/);
});
