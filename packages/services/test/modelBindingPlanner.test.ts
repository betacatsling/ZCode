import assert from "node:assert/strict";
import test from "node:test";
import type { Model } from "@zcode/contracts";
import type {
  CapabilityReport,
  ExecutionTarget,
  HarnessCapabilities,
  SessionSpec,
} from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import {
  ModelBindingPlanner,
  planModelBinding,
  type ExistingModelExecutor,
} from "../src/agent-host/modelBindingPlanner.js";

const selection: ModelSelection = {
  providerId: "provider-a",
  modelId: "model-a",
  options: { reasoningLevel: "off" },
};
const target: ExecutionTarget = {
  id: "local-1",
  kind: "local",
  platform: "linux",
  available: true,
};
const spec: SessionSpec = {
  schemaVersion: 1,
  hostSessionId: "host-1",
  execution: { targetId: "local-1", workspaceIdentity: "workspace-1", worktreePath: "/tmp/demo" },
  harness: { id: "mock", adapterVersion: "1.0.0" },
  modelBinding: { kind: "host-managed", selection },
};

function capabilities(): HarnessCapabilities {
  const yes = { support: "supported" as const };
  const no = { support: "unsupported" as const, reason: "not simulated" };
  return {
    text: yes,
    tools: yes,
    approvals: yes,
    cancelTurn: yes,
    resumeExecution: no,
    history: yes,
    images: no,
    modelSwitch: no,
  };
}

function harness(route: HarnessAdapter["hostManagedRoute"] = "mock"): HarnessAdapter {
  return {
    id: "mock",
    version: "1.0.0",
    hostManagedRoute: route,
    async probe(next) {
      return next.available
        ? { support: "supported" }
        : { support: "unsupported", reason: next.reason ?? "target unavailable" };
    },
    async capabilities() {
      return capabilities();
    },
    async hostManagedSupport(next) {
      return this.probe(next);
    },
    async harnessManagedSupport(next) {
      return this.probe(next);
    },
    async create() {
      throw new Error("planner must not create a session");
    },
    async attach() {
      throw new Error("planner must not attach");
    },
    async send() {
      throw new Error("planner must not send");
    },
    async cancelTurn() {
      throw new Error("planner must not cancel");
    },
    async resolveInteraction() {
      throw new Error("planner must not resolve");
    },
    async terminate() {
      throw new Error("planner must not terminate");
    },
    subscribe() {
      throw new Error("planner must not subscribe");
    },
  };
}

function executor(overrides: Partial<ExistingModelExecutor> = {}): ExistingModelExecutor {
  const model = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    properties: {
      supportsToolCall: true,
      inputFormat: { supportsImage: false },
    },
    optionSpecs: { reasoningLevel: { values: ["off", "low"] } },
    options: { reasoningLevel: "off" },
    bind() {
      throw new Error("planner must not bind a new model");
    },
    generateText() {
      throw new Error("planner must not call the model");
    },
    streamText() {
      throw new Error("planner must not stream the model");
    },
    ...overrides,
  };
  return model as ExistingModelExecutor & Pick<Model, "bind" | "generateText" | "streamText">;
}

function catalog(fingerprint = "revision-1") {
  return {
    fingerprint,
    validateSelection(next: ModelSelection) {
      return next.providerId === "provider-a" &&
        (next.modelId === "model-a" || next.modelId === "model-b")
        ? { ok: true as const }
        : { ok: false as const, reason: "model-not-found" };
    },
    credentialSource() {
      return "provider-api-key" as const;
    },
    credentialRef() {
      return "credential.provider-api-key.provider-a";
    },
  };
}

const planner = new ModelBindingPlanner();

test("host-managed plan freezes route, models, capabilities, credential ref and fingerprint", async () => {
  const plan = await planner.plan({
    spec,
    target,
    harness: harness("pi-sdk"),
    catalog: catalog(),
    executor: executor(),
    backgroundCalls: { support: "supported" },
    gatewayVersion: undefined,
  });
  assert.equal(plan.kind, "host-managed");
  assert.equal(plan.route, "pi-sdk");
  assert.equal(plan.unifiedModelRouting, true);
  assert.equal(plan.hostManagedCertification, "complete");
  assert.equal(plan.execution.kind, "existing-model-runtime");
  assert.deepEqual(plan.requested, spec.modelBinding);
  assert.deepEqual(plan.effective, selection);
  assert.deepEqual(plan.roles.main, selection);
  assert.deepEqual(plan.roles.compact, selection);
  assert.deepEqual(plan.roles.subtask, selection);
  assert.equal(plan.roles.explicit, false);
  assert.equal(plan.capabilities.tools.support, "supported");
  assert.equal(plan.capabilities.images.support, "unsupported");
  assert.match(plan.capabilities.images.reason ?? "", /not simulated/);
  assert.equal(plan.capabilities.reasoning.support, "supported");
  assert.equal(plan.capabilities.resume.support, "unsupported");
  assert.match(plan.capabilities.resume.reason ?? "", /not simulated/);
  assert.equal(plan.limits.modelSwitch, "next-turn-or-new-session");
  assert.equal(plan.credentialRef, "credential.provider-api-key.provider-a");
  assert.equal(plan.credentialSource, "provider-api-key");
  assert.equal(plan.startupOverrides.credentialInjection, "refused");
  assert.equal(plan.startupOverrides.applied, false);
  assert.equal(plan.catalogFingerprint, "revision-1");
  assert.match(plan.versionFingerprint, /^[0-9a-f]{64}$/);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(JSON.stringify(plan).includes("sk-"), false);
  const again = await planner.plan({
    spec,
    target,
    harness: harness("pi-sdk"),
    catalog: catalog(),
    executor: executor(),
    backgroundCalls: { support: "supported" },
  });
  assert.equal(again.versionFingerprint, plan.versionFingerprint);
  const drifted = await planner.plan({
    spec,
    target,
    harness: harness("pi-sdk"),
    catalog: catalog("revision-2"),
    executor: executor(),
    backgroundCalls: { support: "supported" },
  });
  assert.notEqual(drifted.versionFingerprint, plan.versionFingerprint);
  assert.equal(plan.versionFingerprint, plan.versionFingerprint);
});

test("writing a provider URL and key into CLI config is not a completed binding", async () => {
  const secret = "sk-live-secret";
  const plan = await planner.plan({
    spec,
    target,
    harness: harness("native"),
    catalog: catalog(),
    executor: executor(),
    backgroundCalls: { support: "supported" },
    startupOverrides: {
      baseURL: "https://provider.example/v1",
      apiKey: secret,
    },
  });
  assert.equal(plan.support.support, "unsupported");
  assert.match(plan.support.reason ?? "", /not a host-managed binding/);
  assert.equal(plan.unifiedModelRouting, false);
  assert.equal(plan.hostManagedCertification, "incomplete");
  assert.equal(plan.execution.kind, "unbound");
  assert.equal(plan.startupOverrides.credentialInjection, "refused");
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("https://provider.example"), false);
});

test("harness-managed is explicit and does not claim unified model routing", async () => {
  const nativeSpec: SessionSpec = {
    ...spec,
    modelBinding: { kind: "harness-managed", nativeModelId: "native-model" },
  };
  const plan = await planner.plan({
    spec: nativeSpec,
    target,
    harness: harness(),
    catalog: catalog(),
  });
  assert.equal(plan.kind, "harness-managed");
  assert.equal(plan.route, "harness-managed");
  assert.equal(plan.unifiedModelRouting, false);
  assert.equal(plan.hostManagedCertification, "not-applicable");
  assert.equal(plan.execution.kind, "harness-managed");
  assert.equal(plan.effective, undefined);
  assert.equal(plan.credentialRef, undefined);
  assert.equal(plan.requested.kind, "harness-managed");
});

test("omitted model roles stay on the requested selection and divergent roles need an explicit choice", async () => {
  const aligned = await planner.plan({
    spec,
    target,
    harness: harness("native"),
    catalog: catalog(),
    executor: executor(),
    backgroundCalls: { support: "supported" },
  });
  assert.deepEqual(aligned.roles.compact, selection);
  assert.deepEqual(aligned.roles.subtask, selection);
  const other: ModelSelection = { ...selection, modelId: "model-b" };
  const diverged = await planner.plan({
    spec,
    target,
    harness: harness("native"),
    catalog: catalog(),
    executor: executor(),
    roles: { compact: other },
  });
  assert.equal(diverged.support.support, "unsupported");
  assert.match(diverged.support.reason ?? "", /same selection/);
  assert.equal(diverged.effective, undefined);
  const explicit = await planner.plan({
    spec,
    target,
    harness: harness("native"),
    catalog: catalog(),
    executor: executor(),
    backgroundCalls: { support: "supported" },
    explicitRoleConfiguration: true,
    roles: { compact: other },
  });
  assert.equal(explicit.support.support, "supported");
  assert.equal(explicit.roles.explicit, true);
  assert.deepEqual(explicit.effective, selection);
  assert.deepEqual(explicit.roles.compact, other);
  assert.deepEqual(explicit.roles.subtask, selection);
});

test("uncontrolled background calls stay reported and are not complete host-managed auth", async () => {
  const plan = await planner.plan({
    spec,
    target,
    harness: harness("responses-gateway"),
    catalog: catalog(),
    executor: executor(),
    gatewayVersion: "gateway-1",
  });
  assert.equal(plan.support.support, "supported");
  assert.equal(plan.route, "responses-gateway");
  assert.equal(plan.execution.kind, "existing-model-runtime");
  assert.equal(plan.capabilities.backgroundCalls.support, "unknown");
  assert.match(plan.capabilities.backgroundCalls.reason ?? "", /not certified/);
  assert.equal(plan.hostManagedCertification, "incomplete");
  assert.equal(plan.gatewayVersion, "gateway-1");
});

test("gateway compatibility requires a version and the executor identity must match", async () => {
  const missing = await planner.plan({
    spec,
    target,
    harness: harness("messages-gateway"),
    catalog: catalog(),
    executor: executor(),
    backgroundCalls: { support: "supported" },
  });
  assert.equal(missing.support.support, "unsupported");
  assert.match(missing.support.reason ?? "", /gateway version/);
  const mismatch = await planner.plan({
    spec,
    target,
    harness: harness("native"),
    catalog: catalog(),
    executor: executor({ providerId: "other-provider" }),
    backgroundCalls: { support: "supported" },
  });
  assert.equal(mismatch.support.support, "unsupported");
  assert.match(mismatch.support.reason ?? "", /does not match/);
  assert.equal(mismatch.effective, undefined);
});

test("cross-provider opaque state is not migrated and unknown models are not substituted", async () => {
  const migrated = await planner.plan({
    spec,
    target,
    harness: harness("native"),
    catalog: catalog(),
    executor: executor(),
    backgroundCalls: { support: "supported" },
    previous: { providerId: "provider-b", modelId: "model-b", carryOpaqueState: true },
  });
  assert.equal(migrated.support.support, "unsupported");
  assert.equal(migrated.limits.opaqueStateMigration, "refused");
  assert.match(migrated.support.reason ?? "", /cannot be migrated/);
  const unknown = await planner.plan({
    spec: {
      ...spec,
      modelBinding: {
        kind: "host-managed",
        selection: { providerId: "missing", modelId: "none" },
      },
    },
    target,
    harness: harness("native"),
    catalog: catalog(),
  });
  assert.equal(unknown.support.support, "unsupported");
  assert.match(unknown.support.reason ?? "", /model-not-found/);
  assert.equal(unknown.effective, undefined);
});

test("existing wire admission still rejects a missing model and a target mismatch", async () => {
  const bad = await planModelBinding({
    spec,
    target,
    harness: harness(),
    catalog: {
      fingerprint: "revision-1",
      validateSelection: () => ({ ok: false, reason: "model-not-found" }),
    },
  });
  assert.equal(bad.support.support, "unsupported");
  assert.match(bad.support.reason ?? "", /model-not-found/);
  assert.equal("credentialRef" in bad ? bad.credentialRef : undefined, undefined);
  const wrongTarget = await planModelBinding({
    spec,
    target: { ...target, id: "different" },
    harness: harness(),
    catalog: { fingerprint: "revision-1", validateSelection: () => ({ ok: true }) },
  });
  assert.equal(wrongTarget.support.support, "unsupported");
});

test("executor capability facts can only narrow harness reports", async () => {
  const plan = await planner.plan({
    spec,
    target,
    harness: harness("native"),
    catalog: catalog(),
    executor: executor({
      properties: { supportsToolCall: false, inputFormat: { supportsImage: true } },
    } as Partial<ExistingModelExecutor>),
    backgroundCalls: { support: "supported" },
  });
  assert.equal(plan.capabilities.tools.support, "unsupported");
  assert.match(plan.capabilities.tools.reason ?? "", /does not support tool calls/);
  assert.equal(plan.capabilities.images.support, "unsupported");
  const calls: string[] = [];
  const watched = executor();
  const proxy = new Proxy(watched, {
    get(current, property, receiver) {
      if (property === "generateText" || property === "streamText" || property === "bind") {
        calls.push(String(property));
      }
      return Reflect.get(current, property, receiver);
    },
  });
  await planner.plan({
    spec,
    target,
    harness: harness("native"),
    catalog: catalog(),
    executor: proxy,
    backgroundCalls: { support: "supported" as CapabilityReport["support"] },
  });
  assert.deepEqual(calls, []);
});
