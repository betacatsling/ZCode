import assert from "node:assert/strict";
import test from "node:test";
import {
  ACP_ADAPTER_VERSION,
  createAcpHarness,
  devinAcpProfile,
  linkAcpTransports,
} from "../src/agent-adapters/acp/index.js";
import { createExperimentalRegistryDevinHarness } from "../src/agent-adapters/devin/createDevinHarness.js";
import { DEVIN_ADAPTER_VERSION } from "../src/agent-adapters/devin/devinExecutable.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";

/**
 * Print-mode Devin (Host lazy path) and the optional ACP profile both claim harness id `devin`.
 * They must stay mutually exclusive on one registry; Multi-Harness contract after ACP lands.
 */
test("Devin print-mode and ACP profile share id and cannot both register", () => {
  assert.equal(devinAcpProfile.manifest.id, "devin");
  assert.deepEqual(devinAcpProfile.install, { executableName: "devin", args: ["acp"] });
  assert.equal(devinAcpProfile.manifest.adapterVersion, ACP_ADAPTER_VERSION);
  assert.equal(DEVIN_ADAPTER_VERSION, ACP_ADAPTER_VERSION);

  const printMode = createExperimentalRegistryDevinHarness({ root: "/tmp/zcode-devin-print" });
  assert.equal(printMode.id, "devin");
  assert.equal(printMode.version, DEVIN_ADAPTER_VERSION);

  const registry = new HarnessRegistry();
  registry.register(printMode);
  assert.throws(
    () =>
      registry.register(
        createAcpHarness({
          profile: devinAcpProfile,
          openTransport: () => linkAcpTransports().client,
        }),
      ),
    /duplicate or invalid harness: devin/,
  );
});

test("ACP Devin registered first still blocks print-mode Devin", () => {
  const registry = new HarnessRegistry();
  registry.register(
    createAcpHarness({
      profile: devinAcpProfile,
      openTransport: () => linkAcpTransports().client,
    }),
  );
  assert.equal(registry.require("devin").id, "devin");
  assert.throws(
    () =>
      registry.register(createExperimentalRegistryDevinHarness({ root: "/tmp/zcode-devin-print" })),
    /duplicate or invalid harness: devin/,
  );
});
