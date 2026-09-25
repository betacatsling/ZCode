import assert from "node:assert/strict";
import { test } from "node:test";
import { zcodeProtocolMethods } from "@zcode/shared";
import { ZCodeProtocolAgentServer } from "./server.js";

test("boot-held CLI freezes Inbox in constructor before any protocol mutation and only releases exact claimed lease", async () => {
  const server = new ZCodeProtocolAgentServer({
    env: { ZCODE_CORE_BOOT_ADMISSION: "held" },
    createZCodeApp: () => {
      throw new Error("unexpected agent");
    },
  });
  try {
    const denied = await server.handleMessage({
      id: 1,
      method: zcodeProtocolMethods.pluginsInstall,
      params: {},
    });
    assert.match(JSON.stringify(denied), /guard.nativeMaintenanceFrozen/);
    const claim = await server.handleMessage({
      id: 2,
      method: zcodeProtocolMethods.nativeMaintenanceClaimBoot,
      params: {},
    });
    assert.ok(claim && "result" in claim);
    const { lease } = claim.result as { lease: { epoch: string; leaseId: string } };
    assert.match(
      JSON.stringify(
        await server.handleMessage({
          id: 3,
          method: zcodeProtocolMethods.nativeMaintenanceFreeze,
          params: {},
        }),
      ),
      /already frozen/,
    );
    const released = await server.handleMessage({
      id: 4,
      method: zcodeProtocolMethods.nativeMaintenanceRelease,
      params: lease,
    });
    assert.match(JSON.stringify(released), /"released":true/);
    assert.match(
      JSON.stringify(
        await server.handleMessage({
          id: 5,
          method: zcodeProtocolMethods.nativeMaintenanceClaimBoot,
          params: {},
        }),
      ),
      /boot lease unavailable/,
    );
  } finally {
    await server.shutdown();
    server.disposeProjections();
  }
});
