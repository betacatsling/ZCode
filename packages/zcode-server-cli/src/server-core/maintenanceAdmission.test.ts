import assert from "node:assert/strict";
import { test } from "node:test";
import { CoreMaintenanceAdmission } from "./maintenanceAdmission.js";

test("maintenance freezes before fresh activity and releases only matching lease", async () => {
  const order: string[] = [];
  let admissionsAllowed = true;
  const gate = new CoreMaintenanceAdmission({
    async freezeAdmissions() {
      admissionsAllowed = false;
      order.push("freeze");
      return {
        async release() {
          order.push("release");
          admissionsAllowed = true;
        },
      };
    },
    async readActivity() {
      order.push("read");
      assert.equal(admissionsAllowed, false);
      return {
        native: { running: 0, waiting: 1, uncertain: 0 },
        external: { running: 0, waiting: 0, uncertain: 0 },
      };
    },
  });
  const result = await gate.begin();
  assert.deepEqual(order, ["freeze", "read"]);
  assert.equal(result.native.waiting, 1);
  await assert.rejects(gate.begin(), /already held/);
  await assert.rejects(gate.release("00000000-0000-0000-0000-000000000000"), /mismatch/);
  assert.equal(admissionsAllowed, false);
  await gate.release(result.leaseId);
  assert.equal(admissionsAllowed, true);
  assert.deepEqual(order, ["freeze", "read", "release"]);
});

test("shutdown during asynchronous freeze releases the acquired fence without leaking a lease", async () => {
  let finishFreeze!: () => void;
  const frozen = new Promise<void>((resolve) => {
    finishFreeze = resolve;
  });
  let released = 0;
  const gate = new CoreMaintenanceAdmission({
    async freezeAdmissions() {
      await frozen;
      return {
        async release() {
          released++;
        },
      };
    },
    async readActivity() {
      throw new Error("activity must not be read after shutdown");
    },
  });
  const begin = gate.begin();
  const closing = gate.releaseHeld();
  finishFreeze();
  await assert.rejects(begin, /Core closed/);
  await closing;
  assert.equal(released, 1);
  await assert.rejects(gate.begin(), /Core closing/);
});

test("missing source blocks; failed activity read returns uncertain while retaining lease", async () => {
  await assert.rejects(new CoreMaintenanceAdmission(undefined).begin(), /unavailable/);
  let released = false;
  const gate = new CoreMaintenanceAdmission({
    async freezeAdmissions() {
      return {
        async release() {
          released = true;
        },
      };
    },
    async readActivity() {
      throw new Error("offline");
    },
  });
  const result = await gate.begin();
  assert.equal(result.native.uncertain, 1);
  assert.equal(result.external.uncertain, 1);
  assert.equal(released, false);
  await gate.release(result.leaseId);
  assert.equal(released, true);
});
