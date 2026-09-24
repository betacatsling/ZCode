import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { bindHostModel, captureHostModel } from "../src/agent-host/modelBinding.js";

const selection = {
  providerId: "provider-a",
  modelId: "model-a",
  options: { reasoningLevel: "off" },
};
const plan = {
  schemaVersion: 1 as const,
  hostSessionId: "host-a",
  targetId: "local-a",
  harnessId: "pi",
  adapterVersion: "0.87.1",
  catalogFingerprint: '{"config":"r1","account":"r1"}',
  requested: { kind: "host-managed" as const, selection },
  effective: selection,
  route: "pi-sdk" as const,
  support: { support: "supported" as const },
  capabilities: {},
};

test("catalog drift rejects new turn preparation while an already-bound executor remains immutable", async () => {
  let revision = "r1";
  let provider = "provider-a";
  let executions = 0;
  const registry = {
    getSnapshot: () => ({ sourceRevisions: { config: revision, account: "r1" } }),
    validateSelection: () => ({ ok: true as const }),
    getProvider: () => ({
      providerId: provider,
      config: {
        access: { type: "api-key" },
        api: { type: "anthropic-messages", baseUrl: "https://fixture.invalid" },
      },
    }),
    getModel: () => ({ modelId: "model-a", config: {} }),
  };
  const adapter = {
    createModel: (input: { providerId: string }) => ({
      providerId: input.providerId,
      modelId: "model-a",
      async *streamText() {
        executions++;
        yield { type: "start" as const };
      },
    }),
  };
  const captured = bindHostModel({ plan, registry, adapter }) as ReturnType<
    typeof adapter.createModel
  >;
  revision = "r2";
  provider = "provider-b";
  for await (const _event of captured.streamText()) {
    /* capture is a real executor, not a mutable registry pointer */
  }
  assert.equal(executions, 1);
  assert.equal(captured.providerId, "provider-a");
  assert.throws(() => bindHostModel({ plan, registry, adapter }), /catalog changed/);
});

test("captured Pi API identity comes from the same verified config as the Model executor", () => {
  let apiType = "anthropic-messages";
  let baseUrl = "https://first.invalid";
  let credential = "first";
  const snapshots: unknown[] = [];
  const registry = {
    getSnapshot: () => ({ sourceRevisions: { config: "r1", account: "r1" } }),
    validateSelection: () => ({ ok: true as const }),
    getProvider: () => ({
      providerId: "provider-a",
      config: { api: { type: apiType, baseUrl }, access: { type: "api-key", apiKey: credential } },
    }),
    getModel: () => ({ modelId: "model-a", config: {} }),
  };
  const adapter = {
    createModel: (input: unknown) => {
      snapshots.push(input);
      return { providerId: "provider-a", modelId: "model-a" };
    },
  };
  const first = captureHostModel({ plan, registry, adapter });
  assert.equal(first.identity.apiType, "anthropic-messages");
  assert.equal(
    first.identity.endpointFingerprint,
    createHash("sha256").update(baseUrl).digest("hex"),
  );
  assert.equal(JSON.stringify(first).includes(baseUrl), false);
  assert.equal(JSON.stringify(first).includes(credential), false);
  assert.equal(
    (snapshots[0] as { providerConfig: { api: { type: string } } }).providerConfig.api.type,
    first.identity.apiType,
  );
  credential = "second";
  assert.deepEqual(captureHostModel({ plan, registry, adapter }).identity, first.identity);
  apiType = "openai-responses";
  assert.notDeepEqual(captureHostModel({ plan, registry, adapter }).identity, first.identity);
  apiType = "anthropic-messages";
  baseUrl = "https://second.invalid";
  assert.notEqual(
    captureHostModel({ plan, registry, adapter }).identity?.endpointFingerprint,
    first.identity?.endpointFingerprint,
  );
  baseUrl = "";
  assert.equal(captureHostModel({ plan, registry, adapter }).identity, undefined);
  assert.equal(bindHostModel({ plan, registry, adapter }).providerId, "provider-a");
  baseUrl = null as unknown as string;
  assert.equal(captureHostModel({ plan, registry, adapter }).identity, undefined);
});

test("turn model binding uses the frozen registry selection and never changes its route", () => {
  const calls: unknown[] = [];
  const registry = {
    getSnapshot: () => ({ sourceRevisions: { config: "r1", account: "r1" } }),
    validateSelection: () => ({ ok: true as const }),
    getProvider: () => ({
      providerId: "provider-a",
      config: {
        access: { type: "api-key" },
        api: { type: "anthropic-messages", baseUrl: "https://fixture.invalid" },
      },
    }),
    getModel: () => ({
      modelId: "model-a",
      config: { optionSpecs: { reasoningLevel: { values: ["off"] } } },
    }),
  };
  const adapter = {
    createModel: (value: unknown) => {
      calls.push(value);
      return { providerId: "provider-a", modelId: "model-a" };
    },
  };
  const model = bindHostModel({ plan, registry, adapter });
  assert.equal(model.providerId, "provider-a");
  assert.equal(calls.length, 1);
  assert.deepEqual((calls[0] as { options: unknown }).options, { reasoningLevel: "off" });
  assert.throws(
    () =>
      bindHostModel({
        plan,
        registry: {
          ...registry,
          getSnapshot: () => ({ sourceRevisions: { config: "r2", account: "r1" } }),
        },
        adapter,
      }),
    /catalog/,
  );
  assert.throws(
    () =>
      bindHostModel({
        plan: { ...plan, effective: { ...selection, modelId: "another" } },
        registry,
        adapter,
      }),
    /mismatch/,
  );
});
