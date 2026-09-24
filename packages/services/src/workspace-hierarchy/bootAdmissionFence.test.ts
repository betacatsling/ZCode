import assert from "node:assert/strict";
import { test } from "node:test";
import { createMaintenanceCoordination } from "./maintenance.js";

test("initial boot hold predates native startup, composes with maintenance and releases only once", async () => {
  let nativeFences = 0;
  const coordinator = createMaintenanceCoordination({
    initiallyHeld: true,
    nativeFence: async () => {
      nativeFences++;
      return { verify: async () => true, release: async () => {} };
    },
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  });
  assert.equal(nativeFences, 0);
  assert.equal(coordinator.admissionEnabled(), false);
  await assert.rejects(
    coordinator.withAdmission(async () => {}),
    /frozen/,
  );
  const maintenance = await coordinator.freezeAdmissions();
  await coordinator.releaseAdmissions(maintenance);
  assert.equal(coordinator.admissionEnabled(), false);
  coordinator.releaseInitialHold();
  coordinator.releaseInitialHold();
  assert.equal(coordinator.admissionEnabled(), true);
  const next = await coordinator.freezeAdmissions();
  assert.equal(coordinator.admissionEnabled(), false);
  await coordinator.releaseAdmissions(next);
  assert.equal(coordinator.admissionEnabled(), true);
});

test("release during another held maintenance lease does not reopen admission", async () => {
  const coordinator = createMaintenanceCoordination({
    initiallyHeld: true,
    nativeFence: async () => ({ verify: async () => true, release: async () => {} }),
    activity: async () => ({ running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }),
  });
  const lease = await coordinator.freezeAdmissions();
  coordinator.releaseInitialHold();
  assert.equal(coordinator.admissionEnabled(), false);
  await coordinator.releaseAdmissions(lease);
  assert.equal(coordinator.admissionEnabled(), true);
});
