import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACP_SESSION_MACHINE_ID,
  acpHarnessCapabilities,
  createAcpHarness,
  diagnoseAcpInstall,
  gooseAcpProfile,
  linkAcpTransports,
  openCodeAcpProfile,
  type AcpAgentProfile,
} from "../src/agent-adapters/acp/index.js";

const secondAgents: readonly {
  label: string;
  profile: AcpAgentProfile;
  sourcePath: string;
}[] = [
  {
    label: "OpenCode",
    profile: openCodeAcpProfile,
    sourcePath: "../src/agent-adapters/acp/agents/opencode.ts",
  },
  {
    label: "Goose",
    profile: gooseAcpProfile,
    sourcePath: "../src/agent-adapters/acp/agents/goose.ts",
  },
];

/**
 * Second ACP agents (OpenCode / Goose): install probe ≠ session caps;
 * host-managed stays unsupported; profile files stay brand-only (no session/load).
 */
for (const { label, profile, sourcePath } of secondAgents) {
  test(`ACP ${label} install probe does not certify session capabilities`, () => {
    assert.deepEqual(profile.install.args, ["acp"]);
    const missing = diagnoseAcpInstall({ profile, executableFound: false });
    assert.equal(missing.support, "unsupported");

    const found = diagnoseAcpInstall({
      profile,
      executableFound: true,
      versionText: `${profile.install.executableName} 0.0.1`,
    });
    assert.equal(found.support, "supported");
    assert.equal(found.constraints?.executableName, profile.install.executableName);
    assert.deepEqual(found.constraints?.args, ["acp"]);

    const beforeNegotiate = acpHarnessCapabilities(undefined);
    assert.equal(beforeNegotiate.text.support, "unknown");
    assert.equal(beforeNegotiate.tools.support, "unknown");
    assert.equal(beforeNegotiate.resumeExecution.support, "unknown");
    assert.equal(beforeNegotiate.hostManagedModel?.support, "unsupported");
    assert.notEqual(beforeNegotiate.tools.support, found.support);
    assert.notEqual(beforeNegotiate.resumeExecution.support, found.support);
  });

  test(`ACP ${label} hostManagedSupport stays unsupported without opening transport`, async () => {
    const adapter = createAcpHarness({
      profile,
      openTransport: () => linkAcpTransports().client,
    });
    assert.equal(adapter.id, profile.manifest.id);
    assert.equal(adapter.sessionMachineId, ACP_SESSION_MACHINE_ID);
    const hostManaged = await adapter.hostManagedSupport();
    assert.equal(hostManaged.support, "unsupported");
    assert.match(hostManaged.reason ?? "", /host-managed/i);
  });

  test(`ACP ${label} profile does not hardcode session/load`, async () => {
    const source = await readFile(new URL(sourcePath, import.meta.url), "utf8");
    assert.equal(source.includes("session/load"), false);
    assert.equal(source.includes("session/resume"), false);
  });
}
