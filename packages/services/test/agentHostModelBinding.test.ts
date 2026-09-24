import assert from "node:assert/strict";
import test from "node:test";
import { bindHostModel } from "../src/agent-host/modelBinding.js";

const selection = { providerId: "provider-a", modelId: "model-a", options: { reasoningLevel: "off" } };
const plan = {
  schemaVersion: 1 as const, hostSessionId: "host-a", targetId: "local-a", harnessId: "pi",
  adapterVersion: "0.87.1", catalogFingerprint: '{"config":"r1","account":"r1"}',
  requested: { kind: "host-managed" as const, selection }, effective: selection,
  route: "pi-sdk" as const, support: { support: "supported" as const }, capabilities: {},
};

test("turn model binding uses the frozen registry selection and never changes its route", () => {
  const calls: unknown[] = [];
  const registry = {
    getSnapshot: () => ({ sourceRevisions: { config: "r1", account: "r1" } }),
    validateSelection: () => ({ ok: true as const }),
    getProvider: () => ({ providerId: "provider-a", config: { access: { type: "api-key" } } }),
    getModel: () => ({ modelId: "model-a", config: { optionSpecs: { reasoningLevel: { values: ["off"] } } } }),
  };
  const adapter = { createModel: (value: unknown) => { calls.push(value); return { providerId: "provider-a", modelId: "model-a" }; } };
  const model = bindHostModel({ plan, registry, adapter });
  assert.equal(model.providerId, "provider-a");
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { options: unknown }).options, { reasoningLevel: "off" });
  assert.throws(() => bindHostModel({ plan, registry: { ...registry, getSnapshot: () => ({ sourceRevisions: { config: "r2", account: "r1" } }) }, adapter }), /catalog/);
  assert.throws(() => bindHostModel({ plan: { ...plan, effective: { ...selection, modelId: "another" } }, registry, adapter }), /mismatch/);
});
