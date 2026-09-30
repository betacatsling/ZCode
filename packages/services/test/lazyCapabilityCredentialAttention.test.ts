/**
 * Leftover 1 of #334: the "credential needs attention" state is Host-level. The lazy Agent Host's
 * capability paths that never warm the target (native zcode selection, admission-disabled and
 * target-unavailable short-circuits) must report it too, with the same key-free shape and the
 * same auto-clear on a credential change, without starting the target, registering harnesses or
 * sending a Provider request. The warm target's catalog must share the same Host-level state.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Model } from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  EnumOptionSpecConfig,
  LimitOptionSpecConfig,
  ModelConfig,
  ModelInputFormatConfig,
  ModelOptionSpecsConfig,
  ModelOutputFormatConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
} from "@zcode/provider";
import { createNodeProviderRegistryRuntime } from "@zcode/provider-node";
import {
  workspaceSessionBindingCapabilityResultSchema,
  type WorkspaceSessionBindingCapabilityRequest,
} from "@zcode/shared/agent-host";
import { createLazyTargetAgentHostService } from "../src/agent-host/lazyTargetService.js";
import {
  ProviderCredentialAttention,
  providerCredentialFingerprint,
} from "../src/agent-host/providerCredentialAttention.js";

const builtinFilePath = fileURLToPath(
  new URL("../../../config/provider/zcode-builtin.json", import.meta.url),
);

function modelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 16_000,
      inputFormat: new ModelInputFormatConfig({
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      }),
      outputFormat: new ModelOutputFormatConfig({ supportsText: true }),
      supportsToolCall: true,
      supportsJsonSchemaOutput: false,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: true,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: new EnumOptionSpecConfig({
        values: ["off"],
        map: '{"reasoning_effort": "none"}',
      }),
      maxOutputTokens: new LimitOptionSpecConfig({
        max: 256,
        map: '{"max_tokens": maxOutputTokens}',
      }),
    }),
  });
}

function providerConfig(baseUrl: string, apiKey: string): ProviderConfig {
  return new ProviderConfig({
    access: new ApiKeyAccessConfig({ apiKey }),
    api: new ProviderApiConfig({ type: "openai-chat-completions", baseUrl }),
  });
}

/** Counts every request; a capability read must never produce one. */
async function startCountingServer() {
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    request.resume();
    response.writeHead(500).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    requests: () => requests,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

async function createEnvironment(root: string, origin: string) {
  const runtime = createNodeProviderRegistryRuntime({
    zcodeBuiltinFilePath: builtinFilePath,
    personalFilePath: join(root, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  await runtime.start();
  const stale = await runtime.configService.createPersonalProvider({
    providerName: "Stale Provider",
    initialConfig: providerConfig(`${origin}/stale/v1`, "stale-key-v1"),
  });
  await runtime.configService.addPersonalModel(stale.providerId, "stale-model", modelConfig());
  const other = await runtime.configService.createPersonalProvider({
    providerName: "Other Provider",
    initialConfig: providerConfig(`${origin}/other/v1`, "other-key"),
  });
  await runtime.configService.addPersonalModel(other.providerId, "other-model", modelConfig());
  await runtime.registryService.refresh("lazy-capability-fixture");
  return { runtime, staleId: stale.providerId, otherId: other.providerId };
}

/** Marks a Provider the way a host-bound Model does after the executor's typed 401. */
async function markRejected(
  attention: ProviderCredentialAttention,
  runtime: Awaited<ReturnType<typeof createEnvironment>>["runtime"],
  providerId: string,
  modelId: string,
) {
  const snapshot = runtime.registryService.getSnapshot();
  const provider = runtime.registryService.getProvider(providerId);
  assert.ok(snapshot && provider);
  const failing = Object.assign(new Error("Provider authentication failed."), {
    code: "provider_not_configured",
    context: { reason: "auth_failed", statusCode: 401, retryable: false },
  });
  const model = {
    providerId,
    modelId,
    properties: {},
    optionSpecs: {},
    options: {},
    bind: () => model,
    generateText: async () => {
      throw failing;
    },
    streamText: () => {
      throw failing;
    },
  } as unknown as Model;
  const observed = attention.observe(
    model,
    providerCredentialFingerprint(provider.config, snapshot.sourceRevisions.account),
  );
  await assert.rejects(observed.generateText({ messages: [] }), (error) => error === failing);
}

const expectedAttention = (providerId: string, modelId: string) => ({
  reason: "auth_failed",
  action: "reconfigure-provider",
  providerId,
  modelId,
  statusCode: 401,
  retryable: false,
});

function nativeRequest(
  providerId: string,
  modelId: string,
): WorkspaceSessionBindingCapabilityRequest {
  return {
    harnessId: "zcode",
    modelBinding: {
      kind: "native-selection",
      selection: { providerId, modelId, options: { reasoningLevel: "off" } },
    },
  };
}

function piRequest(providerId: string, modelId: string): WorkspaceSessionBindingCapabilityRequest {
  return {
    harnessId: "pi",
    modelBinding: {
      kind: "host-managed",
      selection: { providerId, modelId, options: { reasoningLevel: "off" } },
    },
  };
}

function assertKeyFree(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of ["stale-key", "other-key", "127.0.0.1", "http"])
    assert.equal(serialized.includes(secret), false, secret);
  assert.equal(/[0-9a-f]{64}/.test(serialized), false, "no credential fingerprint");
}

const target = (available: boolean) => ({
  id: "local",
  kind: "local" as const,
  platform: process.platform as "linux",
  available,
});

test(
  "cold lazy capability reports Host-level credential attention without warming, and clears on reconfigure",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lazy-cap-attention-"));
    const server = await startCountingServer();
    const env = await createEnvironment(root, server.origin);
    const registered: string[] = [];
    let admission = false;
    const credentialAttention = new ProviderCredentialAttention();
    const lazy = createLazyTargetAgentHostService({
      root: join(root, "host"),
      target: target(true),
      registry: env.runtime.registryService,
      allowNewSessions: () => admission,
      nativeOwner: {
        createWorkspaceSession: async () => {
          throw new Error("native-not-used");
        },
      } as never,
      observeRegisteredHarness: (harness) => {
        registered.push(harness.id);
      },
      credentialAttention,
    } as Parameters<typeof createLazyTargetAgentHostService>[0]);
    const unavailable = createLazyTargetAgentHostService({
      root: join(root, "host-down"),
      target: target(false),
      registry: env.runtime.registryService,
      allowNewSessions: () => true,
      observeRegisteredHarness: (harness) => {
        registered.push(harness.id);
      },
      credentialAttention,
    } as Parameters<typeof createLazyTargetAgentHostService>[0]);
    try {
      // Nothing marked yet: no field on any cold path.
      const before = await lazy.service.getWorkspaceSessionCapability(
        nativeRequest(env.staleId, "stale-model"),
      );
      assert.equal("credentialAttention" in before, false);

      await markRejected(credentialAttention, env.runtime, env.staleId, "stale-model");

      // Native zcode selection (history-only owner): reported, report itself unchanged.
      const native = await lazy.service.getWorkspaceSessionCapability(
        nativeRequest(env.staleId, "stale-model"),
      );
      assert.equal(native.report.support, "supported");
      assert.deepEqual(
        (native as Record<string, unknown>).credentialAttention,
        expectedAttention(env.staleId, "stale-model"),
      );
      assertKeyFree(native);
      assert.deepEqual(workspaceSessionBindingCapabilityResultSchema.parse(native), native);
      // Another Provider is not marked.
      const otherNative = await lazy.service.getWorkspaceSessionCapability(
        nativeRequest(env.otherId, "other-model"),
      );
      assert.equal("credentialAttention" in otherNative, false);

      // Admission-disabled short-circuit for an external harness: still unsupported, plus attention.
      const disabled = await lazy.service.getWorkspaceSessionCapability(
        piRequest(env.staleId, "stale-model"),
      );
      assert.deepEqual(disabled.report, { support: "unsupported", reason: "admission-disabled" });
      assert.deepEqual(
        (disabled as Record<string, unknown>).credentialAttention,
        expectedAttention(env.staleId, "stale-model"),
      );
      assertKeyFree(disabled);
      // Target-unavailable short-circuit reads the same Host-level state.
      const down = await unavailable.service.getWorkspaceSessionCapability(
        piRequest(env.staleId, "stale-model"),
      );
      assert.deepEqual(down.report, { support: "unsupported", reason: "target-unavailable" });
      assert.deepEqual(
        (down as Record<string, unknown>).credentialAttention,
        expectedAttention(env.staleId, "stale-model"),
      );
      // Harness-managed bindings name no Provider: never a field.
      const harnessManaged = await lazy.service.getWorkspaceSessionCapability({
        harnessId: "codex",
        modelBinding: { kind: "harness-managed" },
      });
      assert.equal("credentialAttention" in harnessManaged, false);

      // Reconfigure the credential: the very next cold read reports nothing, before any turn.
      await env.runtime.configService.savePersonalProviderOverlay(
        env.staleId,
        providerConfig(`${server.origin}/stale/v1`, "stale-key-v2"),
      );
      await env.runtime.registryService.refresh("user-rotated-key");
      for (const read of [
        lazy.service.getWorkspaceSessionCapability(nativeRequest(env.staleId, "stale-model")),
        lazy.service.getWorkspaceSessionCapability(piRequest(env.staleId, "stale-model")),
        unavailable.service.getWorkspaceSessionCapability(piRequest(env.staleId, "stale-model")),
      ]) {
        assert.equal("credentialAttention" in (await read), false);
      }

      // Lazy semantics kept: nothing warmed, nothing registered, no Provider request.
      assert.deepEqual(registered, []);
      assert.equal(server.requests(), 0);
      assert.equal((await lazy.service.getAvailability()).harnesses.includes("pi"), false);
    } finally {
      await lazy.dispose().catch(() => undefined);
      await unavailable.dispose().catch(() => undefined);
      env.runtime.dispose();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "the warm target's catalog shares the Host-level credential attention",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lazy-cap-attention-warm-"));
    const server = await startCountingServer();
    const env = await createEnvironment(root, server.origin);
    const credentialAttention = new ProviderCredentialAttention();
    const lazy = createLazyTargetAgentHostService({
      root: join(root, "host"),
      target: target(true),
      registry: env.runtime.registryService,
      allowNewSessions: () => true,
      credentialAttention,
    } as Parameters<typeof createLazyTargetAgentHostService>[0]);
    try {
      await markRejected(credentialAttention, env.runtime, env.staleId, "stale-model");
      // External harness capability warms the target (existing lazy behaviour) and uses its catalog.
      const warm = await lazy.service.getWorkspaceSessionCapability(
        piRequest(env.staleId, "stale-model"),
      );
      assert.equal(warm.report.support, "supported");
      assert.deepEqual(
        (warm as Record<string, unknown>).credentialAttention,
        expectedAttention(env.staleId, "stale-model"),
      );
      const other = await lazy.service.getWorkspaceSessionCapability(
        piRequest(env.otherId, "other-model"),
      );
      assert.equal("credentialAttention" in other, false);
      await env.runtime.configService.savePersonalProviderOverlay(
        env.staleId,
        providerConfig(`${server.origin}/stale/v1`, "stale-key-v2"),
      );
      await env.runtime.registryService.refresh("user-rotated-key");
      const cleared = await lazy.service.getWorkspaceSessionCapability(
        piRequest(env.staleId, "stale-model"),
      );
      assert.equal("credentialAttention" in cleared, false);
      assert.equal(server.requests(), 0);
    } finally {
      await lazy.dispose().catch(() => undefined);
      env.runtime.dispose();
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
