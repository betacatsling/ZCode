import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Model, ModelRequest } from "@zcode/contracts";
import type { ProviderRegistryService } from "@zcode/provider";
import type { BindingPlan, ExecutionTarget } from "@zcode/shared/agent-host";
import { TargetModelGateway, describeGatewayCompatibility } from "@zcode/services/model-gateway";
import { CodexHarnessAdapter } from "../src/agent-adapters/codex/codexHarnessAdapter.js";
import {
  CodexTargetGateway,
  resolveCodexTargetGateway,
} from "../src/agent-adapters/codex/codexTargetGateway.js";
import { createExperimentalRegistryCodexHarness } from "../src/agent-adapters/codex/createCodexHarness.js";
import { createLazyTargetAgentHostService } from "../src/agent-host/lazyTargetService.js";
import { planAttachmentClose } from "../src/agent-host/runtime/attachment.js";

const sshTarget: ExecutionTarget = {
  id: "ssh-core-1",
  kind: "ssh",
  platform: "linux",
  available: true,
};

const selection = {
  providerId: "provider-test",
  modelId: "model-test",
  options: { reasoningLevel: "off" },
};

const limits = {
  maxBodyBytes: 4096,
  maxRequests: 20,
  maxConcurrent: 2,
  maxOutputTokens: 200,
  maxOutputTokensPerRequest: 100,
};

function fakeRegistry(): ProviderRegistryService {
  return {
    start: async () => undefined,
    getProvider: () => undefined,
    validateSelection: () => ({ ok: false, reason: "fixture" }),
  } as unknown as ProviderRegistryService;
}

function fakeModel(): Model {
  const value = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    properties: { contextWindow: 4096 },
    optionSpecs: { maxOutputTokens: { max: 128 } },
    options: { reasoningLevel: "off" },
    bind() {
      return this;
    },
    async generateText() {
      throw new Error("Fake Model test uses streaming only");
    },
    async *streamText(_request: ModelRequest) {
      yield { type: "start" };
      yield { type: "text_start", id: "text-1" };
      yield { type: "text_delta", id: "text-1", text: "fake response" };
      yield { type: "text_end", id: "text-1" };
      yield {
        type: "finish",
        finishReason: "stop",
        usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
      };
    },
  };
  return value as unknown as Model;
}

function plan(): BindingPlan {
  return {
    schemaVersion: 1,
    hostSessionId: "host-session-1",
    targetId: sshTarget.id,
    harnessId: "codex",
    adapterVersion: "0.157.1",
    catalogFingerprint: "catalog-fp",
    requested: { kind: "host-managed", selection },
    effective: selection,
    route: "responses-gateway",
    support: { support: "supported" },
    capabilities: {},
  } as BindingPlan;
}

function responsesBody(): Record<string, unknown> {
  return {
    client_metadata: { session_id: "codex-session-1", thread_id: "codex-thread-1" },
    include: ["reasoning.encrypted_content"],
    input: [
      { type: "message", role: "developer", content: [{ type: "input_text", text: "dev rules" }] },
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
    ],
    instructions: "system layer",
    model: "zcode-host",
    parallel_tool_calls: true,
    prompt_cache_key: "fixture-cache-key",
    reasoning: { effort: "none" },
    store: false,
    stream: true,
    tool_choice: "auto",
    tools: [],
  };
}

test("SSH compatibility stays experimental and does not certify remote credentials", () => {
  const row = describeGatewayCompatibility({
    harnessId: "codex",
    harnessVersion: "0.157.1",
    modelSource: selection,
    target: sshTarget,
    route: "responses-gateway",
  });
  assert.equal(row.targetKind, "ssh");
  assert.equal(row.report.support, "experimental");
  assert.match(row.report.reason ?? "", /loopback Gateway must run on the target host/);
  assert.match(row.report.reason ?? "", /remote credential paths are not certified/);
  assert.notEqual(row.report.support, "supported");
});

test("injected Codex owner is the shared Gateway; the default owner stays private", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-gateway-inject-"));
  const shared = new TargetModelGateway();
  try {
    const preferred = resolveCodexTargetGateway({ injected: shared, now: () => 1 });
    assert.equal(preferred.ownsGateway, false);
    assert.equal(preferred.gateway, shared);
    const fallback = resolveCodexTargetGateway({ now: () => 1 });
    assert.equal(fallback.ownsGateway, true);
    assert.ok(fallback.gateway instanceof CodexTargetGateway);
    assert.notEqual(fallback.gateway, shared);

    const harness = createExperimentalRegistryCodexHarness({
      root,
      registry: fakeRegistry(),
      targetModelGateway: shared,
    });
    assert.ok(harness instanceof CodexHarnessAdapter);
    assert.equal(harness.boundTargetGateway(), shared);
    await harness.shutdown();
    assert.equal(shared.get(sshTarget.id), shared.get(sshTarget.id));

    const owned = createExperimentalRegistryCodexHarness({
      root,
      registry: fakeRegistry(),
    });
    const ownedGateway = owned.boundTargetGateway();
    assert.ok(ownedGateway instanceof CodexTargetGateway);
    assert.notEqual(ownedGateway, shared);
    await owned.shutdown();
    await assert.rejects(async () => {
      ownedGateway.get(sshTarget.id);
    }, /closed/);
    await fallback.gateway.close();
  } finally {
    await shared.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shared Gateway serves FakeModel on loopback for an ssh target and survives tunnel drop", async (t) => {
  const owner = new TargetModelGateway();
  const gateway = owner.get(sshTarget.id);
  assert.throws(() => owner.get("other-ssh-target"), /another execution target/);
  const { baseUrl } = await gateway.start();
  const url = new URL(baseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  t.after(() => owner.close());
  const grant = gateway.createGrant({
    protocol: "openai-responses",
    sessionId: "host-session-1",
    modelBindingFingerprint: "catalog-fp",
    publicModelId: "zcode-host",
    model: fakeModel(),
    plan: plan(),
    expiresInMs: 60_000,
    limits,
  });
  const post = () =>
    fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(responsesBody()),
    });
  const first = await post();
  assert.equal(first.status, 200);
  assert.match(await first.text(), /fake response/);
  const disconnect = planAttachmentClose("ssh-disconnect");
  assert.equal(disconnect.closeTunnel, true);
  assert.equal(disconnect.stopSupervisor, false);
  assert.equal(disconnect.stopWorkers, false);
  const afterDisconnect = await post();
  assert.equal(afterDisconnect.status, 200);
  await afterDisconnect.body?.cancel();
  const stop = planAttachmentClose("explicit-stop");
  assert.equal(stop.stopSupervisor, true);
  assert.equal(stop.stopWorkers, true);
  await owner.close();
  await assert.rejects(post(), /fetch failed|ECONNREFUSED|connect/);
});

test("lazy SSH target injects one shared Gateway into Codex and leaves Claude on its own owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-ssh-gateway-lazy-"));
  const closes = new Map<object, number>();
  const original = TargetModelGateway.prototype.close;
  TargetModelGateway.prototype.close = async function (this: TargetModelGateway) {
    closes.set(this, (closes.get(this) ?? 0) + 1);
    return original.call(this);
  };
  const codexGateways: object[] = [];
  let claudeRegistered = false;
  try {
    const host = createLazyTargetAgentHostService({
      root,
      target: sshTarget,
      registry: fakeRegistry(),
      allowNewSessions: () => true,
      observeRegisteredHarness(harness) {
        if (harness.id === "claude-code") claudeRegistered = true;
        if (harness instanceof CodexHarnessAdapter)
          codexGateways.push(harness.boundTargetGateway());
      },
    });
    const capability = await host.service.getWorkspaceSessionCapability({
      harnessId: "codex",
      modelBinding: { kind: "harness-managed" },
    });
    assert.equal(capability.targetId, sshTarget.id);
    assert.equal(claudeRegistered, true);
    assert.deepEqual(codexGateways, [host.targetModelGateway]);
    await host.dispose();
    // Claude 关闭自己的实例一次。Codex 不关闭注入的 owner。dispose 关闭共享 owner 一次。
    assert.equal(closes.size, 2);
    assert.equal(closes.get(host.targetModelGateway), 1);
  } finally {
    TargetModelGateway.prototype.close = original;
    await rm(root, { recursive: true, force: true });
  }
});
