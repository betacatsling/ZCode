import assert from "node:assert/strict";
import { test } from "node:test";
import { coreMessageSchema } from "../contracts.js";
import { maintenanceBeginReply } from "./maintenanceReply.js";

test("Core serializes a held maintenance lease with validated native/external activity fields", () => {
  const requestId = "9f71fc70-718b-48e6-a16d-0f019931ff31";
  const leaseId = "9982ae39-93c0-400c-9d7c-780f9e5c7c20";
  const reply = maintenanceBeginReply(requestId, {
    leaseId,
    native: { running: 1, waiting: 0, uncertain: 0 },
    external: { running: 0, waiting: 1, uncertain: 0 },
  });
  assert.deepEqual(coreMessageSchema.parse(reply), {
    type: "maintenance",
    requestId,
    leaseId,
    nativeActivity: { running: 1, waiting: 0, uncertain: 0 },
    externalActivity: { running: 0, waiting: 1, uncertain: 0 },
  });
});
