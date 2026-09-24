import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { ZCODE_VERSION } from "@zcode/shared";
import { mountLocalCore } from "./targetCoreMount.js";
import {
  IAgentHostService,
  IZCodeAgentService,
  ISettingService,
  IMediaPreviewService,
  prepareTargetAttachment,
} from "@zcode/services";
import { connectTargetHostRpc } from "./targetHostRpc.js";

test("window Host mounts a real disposable child Core RPC without local native factory; detach keeps Core alive", async () => {
  const child = fork(
    fileURLToPath(new URL("./fixtures/targetHostRpcServer.ts", import.meta.url)),
    [],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  try {
    const [ready] = (await once(child, "message")) as [{ port: number }];
    const location = {
      endpoint: `http://127.0.0.1:${ready.port}`,
      installationId: "child-target",
      version: ZCODE_VERSION,
      generation: 1,
    };
    await assert.rejects(
      mountLocalCore({ ...location, installationId: "other-target" }),
      /identity mismatch/,
    );
    await assert.rejects(
      mountLocalCore({ ...location, version: "old-version" }),
      /version mismatch/,
    );
    const first = await mountLocalCore(location);
    assert(first.services.getOptional(IAgentHostService));
    assert(first.services.getOptional(IZCodeAgentService));
    assert(first.services.getOptional(ISettingService));
    assert(first.services.getOptional(IMediaPreviewService));
    assert.equal(
      (await first.services.get(IAgentHostService).getAvailability()).target.id,
      "child-target",
    );
    first.attachment.dispose();
    assert.equal(child.exitCode, null);
    const oneUseTicket = await prepareTargetAttachment(
      location.endpoint,
      location.installationId,
      undefined,
      location.version,
    );
    const issued = await connectTargetHostRpc(oneUseTicket);
    issued.dispose();
    await assert.rejects(connectTargetHostRpc(oneUseTicket));
    assert.equal(child.exitCode, null);
    const second = await mountLocalCore(location);
    assert.equal(
      (await second.services.get(IAgentHostService).getAvailability()).target.id,
      "child-target",
    );
    const closed = new Promise<void>((resolve) => second.attachment.onDidClose(resolve));
    child.send("stop");
    await once(child, "exit");
    await closed;
    second.attachment.dispose();
  } finally {
    if (child.exitCode === null) {
      child.send("stop");
      await once(child, "exit");
    }
  }
});
