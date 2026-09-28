import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACP_SESSION_MACHINE_ID,
  acpHarnessCapabilities,
  createAcpHarness,
  diagnoseAcpInstall,
  devinAcpProfile,
  linkAcpTransports,
} from "../src/agent-adapters/acp/index.js";

const localTarget = {
  id: "local",
  kind: "local" as const,
  platform: process.platform as "darwin" | "linux" | "win32",
  available: true,
};

/**
 * ACP Devin: install/probe must not upgrade session caps; host-managed stays unsupported.
 * Soft siblings mirror OpenCode/Goose honesty (#225): no transport open on support reads;
 * profile stays brand-only (no session/load). ≠ print-mode honesty / SessionHost.
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
  let opened = 0;
  const adapter = createAcpHarness({
    profile: devinAcpProfile,
    openTransport: () => {
      opened += 1;
      return linkAcpTransports().client;
    },
  });
  assert.equal(adapter.id, "devin");
  assert.equal(adapter.sessionMachineId, ACP_SESSION_MACHINE_ID);
  const hostManaged = await adapter.hostManagedSupport();
  assert.equal(hostManaged.support, "unsupported");
  assert.match(hostManaged.reason ?? "", /host-managed/i);
  assert.equal(opened, 0, "hostManagedSupport must not open ACP transport");

  // Install-found ≠ harness-managed admission: unknown until initialize/probe.
  const harnessManaged = await adapter.harnessManagedSupport(localTarget);
  assert.equal(harnessManaged.support, "unknown");
  assert.match(harnessManaged.reason ?? "", /initialize/i);
  assert.equal(opened, 0, "harnessManagedSupport without probe must not open transport");
});

test("ACP Devin profile does not hardcode session/load", async () => {
  const source = await readFile(
    new URL("../src/agent-adapters/acp/agents/devin.ts", import.meta.url),
    "utf8",
  );
  assert.equal(source.includes("session/load"), false);
  assert.equal(source.includes("session/resume"), false);
});
