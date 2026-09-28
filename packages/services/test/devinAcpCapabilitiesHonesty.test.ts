import assert from "node:assert/strict";
import test from "node:test";
import {
  acpHarnessCapabilities,
  createAcpHarness,
  diagnoseAcpInstall,
  devinAcpProfile,
  linkAcpTransports,
} from "../src/agent-adapters/acp/index.js";

/**
 * ACP Devin: install/probe must not upgrade session caps; host-managed stays unsupported.
 * Mirrors print-mode honesty (`devinCapabilitiesHonesty`) for the optional ACP profile path.
 */
test("ACP Devin install probe does not certify session capabilities", () => {
  const missing = diagnoseAcpInstall({ profile: devinAcpProfile, executableFound: false });
  assert.equal(missing.support, "unsupported");

  const found = diagnoseAcpInstall({
    profile: devinAcpProfile,
    executableFound: true,
    versionText: "devin 0.0.1",
  });
  assert.equal(found.support, "supported");
  assert.equal(found.constraints?.executableName, "devin");
  assert.deepEqual(found.constraints?.args, ["acp"]);

  const beforeNegotiate = acpHarnessCapabilities(undefined);
  assert.equal(beforeNegotiate.text.support, "unknown");
  assert.equal(beforeNegotiate.tools.support, "unknown");
  assert.equal(beforeNegotiate.resumeExecution.support, "unknown");
  assert.equal(beforeNegotiate.hostManagedModel?.support, "unsupported");
  assert.match(beforeNegotiate.hostManagedModel?.reason ?? "", /host-managed/i);
  assert.notEqual(beforeNegotiate.tools.support, found.support);
  assert.notEqual(beforeNegotiate.resumeExecution.support, found.support);
  assert.equal(beforeNegotiate.modelSwitch.support, "unsupported");
});

test("ACP Devin hostManagedSupport stays unsupported without opening transport", async () => {
  const adapter = createAcpHarness({
    profile: devinAcpProfile,
    openTransport: () => linkAcpTransports().client,
  });
  assert.equal(adapter.id, "devin");
  // hostManagedSupport must not open ACP transport / initialize
  const hostManaged = await adapter.hostManagedSupport();
  assert.equal(hostManaged.support, "unsupported");
  assert.match(hostManaged.reason ?? "", /host-managed/i);
});
