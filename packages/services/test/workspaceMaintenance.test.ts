import assert from "node:assert/strict";
import { test } from "node:test";
import { createMaintenanceCoordination } from "../src/workspace-hierarchy/maintenance.js";

test("maintenance freezes admission before fresh native+external activity and holds through action", async () => {
  const sequence: string[] = [];
  let releaseAdmission!: () => void;
  const unfinished = new Promise<void>((resolve) => { releaseAdmission = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const coordination = createMaintenanceCoordination({
    nativeFence: async () => { sequence.push("native:frozen"); return async () => { sequence.push("native:unfrozen"); }; },
    activity: async () => { sequence.push("fresh:activity"); return { running: 0, waiting: 0, tools: 0, uncertain: 0, offline: false }; },
  });
  const admitted = coordination.withAdmission(async () => { sequence.push("accepted"); entered(); await unfinished; sequence.push("finished"); });
  await ready;
  const updating = coordination.withMaintenance(async () => { sequence.push("update"); assert.equal(coordination.admissionEnabled(), false); });
  await assert.rejects(coordination.withAdmission(async () => {}), /frozen/);
  assert.equal(sequence.includes("fresh:activity"), false);
  releaseAdmission();
  await admitted;
  await updating;
  assert.deepEqual(sequence, ["accepted", "native:frozen", "finished", "fresh:activity", "update", "native:unfrozen"]);
  assert.equal(coordination.admissionEnabled(), true);
});

test("unknown/offline activity rejects automatic maintenance and unfreezes native without running action", async () => {
  let released = false;
  let performed = false;
  const coordination = createMaintenanceCoordination({
    nativeFence: async () => async () => { released = true; },
    activity: async () => ({ running: 0, waiting: 0, tools: 1, uncertain: 1, offline: true }),
  });
  await assert.rejects(coordination.withMaintenance(async () => { performed = true; }), /busy or uncertain/);
  assert.equal(performed, false);
  assert.equal(released, true);
  assert.equal(coordination.admissionEnabled(), true);
});
