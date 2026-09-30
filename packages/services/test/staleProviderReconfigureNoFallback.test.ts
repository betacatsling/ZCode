import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ModelNetworkStatusEvent } from "@zcode/contracts";
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
  agentCommandReceiptSchema,
  type AgentEvent,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import { createRegistryPiHarness } from "../src/agent-adapters/pi/createPiHarness.js";
import { createAgentHostConversationBridge } from "../src/agent-host/conversationBridge.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { createRegistryModelCatalog } from "../src/agent-host/registryCatalog.js";
import { AgentHostTargetService } from "../src/agent-host/targetService.js";

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

interface CapturedRequest {
  readonly route: string;
  readonly authorization: string | undefined;
}

/** Loopback fakes: /stale/ is the session's Provider, /other/ is a configured alternative. */
async function startFakes() {
  const requests: CapturedRequest[] = [];
  const expiredKeys = new Set<string>();
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const route = request.url?.split("/")[1] ?? "unknown";
      const authorization = request.headers.authorization;
      requests.push({ route, authorization });
      if (authorization && expiredKeys.has(authorization.replace(/^Bearer /, ""))) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ error: { message: "expired personal key", type: "auth_error" } }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: `answer-from-${route}` }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    requests,
    expiredKeys,
    count: (route: string) => requests.filter((request) => request.route === route).length,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

/** Real Registry + real AiSdkModelAdapter + real Pi harness, wired like lazyTargetService. */
async function createHostEnvironment(root: string, origin: string) {
  const worktree = join(root, "worktree");
  await mkdir(worktree, { recursive: true });
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
  await runtime.registryService.refresh("stale-provider-fixture");

  const createdModels: Array<{ providerId: string; modelId: string }> = [];
  const statuses: ModelNetworkStatusEvent[] = [];
  class RecordingModelAdapter extends AiSdkModelAdapter {
    override createModel(input: Parameters<AiSdkModelAdapter["createModel"]>[0]) {
      createdModels.push({ providerId: input.providerId, modelId: input.modelId });
      return super.createModel(input);
    }
  }
  const adapter = new RecordingModelAdapter({
    streamIdleTimeoutMs: 5_000,
    statusSink: {
      publish: (event) => {
        statuses.push(event);
      },
    },
  });
  const target = {
    id: "local",
    kind: "local" as const,
    platform: process.platform as "darwin" | "linux",
    available: true,
  };
  const makeTarget = () => {
    const harnesses = new HarnessRegistry();
    harnesses.register(
      createRegistryPiHarness({
        root: join(root, "workers"),
        registry: runtime.registryService,
        adapter,
      }),
    );
    return new AgentHostTargetService({
      root: join(root, "host"),
      target,
      catalog: createRegistryModelCatalog(runtime.registryService, adapter),
      registry: harnesses,
      authorizeWorktree: async () => true,
    });
  };
  const specFor = (
    hostSessionId: string,
    selection: { providerId: string; modelId: string },
  ): SessionSpec => ({
    schemaVersion: 1,
    hostSessionId,
    execution: {
      targetId: target.id,
      workspaceIdentity: "stale-workspace",
      worktreePath: worktree,
    },
    harness: { id: "pi", adapterVersion: "0.87.1" },
    modelBinding: {
      kind: "host-managed",
      selection: { ...selection, options: { reasoningLevel: "off" } },
    },
  });
  return {
    runtime,
    worktree,
    staleId: stale.providerId,
    otherId: other.providerId,
    createdModels,
    statuses,
    makeTarget,
    specFor,
  };
}

function turnEvents(events: readonly AgentEvent[], turnId: string) {
  return events.filter((event) => "turnId" in event && event.turnId === turnId);
}

function assistantTexts(events: readonly AgentEvent[], turnId: string): string[] {
  return turnEvents(events, turnId).flatMap((event) =>
    event.kind === "message.finished" && event.role === "assistant" ? [event.text] : [],
  );
}

function send(target: AgentHostTargetService, spec: SessionSpec, turn: string, text: string) {
  return target.dispatch(spec, {
    type: "send",
    commandId: `${turn}-command`,
    hostSessionId: spec.hostSessionId,
    turnId: turn,
    text,
  });
}

/** Typed attach/create refusal: same invalid-binding code as the send receipt, never a bare Error. */
function assertReconfigureRequired(providerId: string, modelId: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    const typed = error as Error & Record<string, unknown>;
    assert.equal(typed.name, "ModelBindingReconfigureRequiredError");
    assert.equal(typed.code, "invalid-binding");
    assert.equal(typed.reason, "provider-not-found");
    assert.equal(typed.action, "reconfigure-provider");
    assert.equal(typed.providerId, providerId);
    assert.equal(typed.modelId, modelId);
    assert.equal(typed.message, "provider-not-found");
    return true;
  };
}

test(
  "removed Provider: new turn, reattach and new session require reconfiguration; no fallback",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-stale-provider-removed-"));
    const fakes = await startFakes();
    const env = await createHostEnvironment(root, fakes.origin);
    let target = env.makeTarget();
    const bridge = createAgentHostConversationBridge(target);
    try {
      const spec = env.specFor("removed-provider-session", {
        providerId: env.staleId,
        modelId: "stale-model",
      });
      const originalBinding = structuredClone(spec.modelBinding);
      await bridge.createExternalSession({ spec });
      assert.equal((await send(target, spec, "turn-1", "remember me")).status, "accepted");
      await target.waitForIdle(spec);
      assert.deepEqual(assistantTexts(await target.eventsSince(spec, 0), "turn-1"), [
        "answer-from-stale",
      ]);
      assert.deepEqual(fakes.requests, [{ route: "stale", authorization: "Bearer stale-key-v1" }]);

      // The user removes the session's Provider; B stays configured and valid.
      await env.runtime.configService.deletePersonalProvider(env.staleId);
      await env.runtime.registryService.refresh("user-removed-provider");
      assert.equal(env.runtime.registryService.getProvider(env.staleId), undefined);
      assert.ok(env.runtime.registryService.getModel(env.otherId, "other-model"));
      const modelsBefore = env.createdModels.length;

      // New turn on the live session: rejected before any Model is created or called.
      const turn2 = await send(target, spec, "turn-2", "continue after removal");
      assert.equal(turn2.status, "rejected");
      assert.equal(turn2.reasonCode, "invalid-binding");
      assert.equal(turn2.message, "provider-not-found");
      assert.deepEqual(await target.queryCommand(spec, "turn-2-command"), turn2);
      const afterReject = await target.eventsSince(spec, 0);
      assert.deepEqual(turnEvents(afterReject, "turn-2"), []);
      assert.equal(env.createdModels.length, modelsBefore);

      // Resume/continue after restart: attach refuses to replan onto anything else.
      await target.close();
      target = env.makeTarget();
      await assert.rejects(
        target.attach(spec),
        assertReconfigureRequired(env.staleId, "stale-model"),
      );
      // Creating a session with the same stale binding is refused and leaves no manifest.
      const staleCreate = env.specFor("new-session-with-stale-binding", {
        providerId: env.staleId,
        modelId: "stale-model",
      });
      await assert.rejects(
        target.create(staleCreate),
        assertReconfigureRequired(env.staleId, "stale-model"),
      );
      assert.deepEqual(
        await target.getWorkspaceSessionCapability({
          harnessId: "pi",
          modelBinding: staleCreate.modelBinding,
        }),
        { targetId: "local", report: { support: "unsupported", reason: "model-unavailable" } },
      );
      const listed = await target.listSessions("stale-workspace", env.worktree);
      assert.deepEqual(
        listed.map((summary) => summary.spec.hostSessionId),
        ["removed-provider-session"],
      );
      assert.deepEqual(listed[0]?.spec.modelBinding, originalBinding);
      assert.equal(
        JSON.stringify((await target.snapshot(spec)).rows.window).includes("answer-from-stale"),
        true,
        "history stays readable while execution is blocked",
      );
      assert.equal(fakes.count("other"), 0);
      assert.equal(fakes.count("stale"), 1);
      assert.equal(env.createdModels.length, modelsBefore);
      assert.equal(
        env.createdModels.every((model) => model.providerId === env.staleId),
        true,
      );

      // Reconfigure: the user re-adds the Provider (same id) with a fresh key and the model.
      const readded = await env.runtime.configService.createPersonalProvider({
        providerName: "Stale Provider",
        initialConfig: providerConfig(`${fakes.origin}/stale/v1`, "stale-key-v2"),
      });
      assert.equal(readded.providerId, env.staleId);
      await env.runtime.configService.addPersonalModel(env.staleId, "stale-model", modelConfig());
      await env.runtime.registryService.refresh("user-readded-provider");
      await target.attach(spec);
      assert.equal(
        (await send(target, spec, "turn-3", "continue after re-add")).status,
        "accepted",
      );
      await target.waitForIdle(spec);
      const afterReconfigure = await target.eventsSince(spec, 0);
      assert.deepEqual(assistantTexts(afterReconfigure, "turn-3"), ["answer-from-stale"]);
      assert.deepEqual(fakes.requests, [
        { route: "stale", authorization: "Bearer stale-key-v1" },
        { route: "stale", authorization: "Bearer stale-key-v2" },
      ]);
      assert.deepEqual(
        env.createdModels.map((model) => `${model.providerId}/${model.modelId}`),
        env.createdModels.map(() => `${env.staleId}/stale-model`),
      );
      assert.deepEqual(
        (await target.listSessions("stale-workspace", env.worktree))[0]?.spec.modelBinding,
        originalBinding,
      );
    } finally {
      bridge.dispose();
      await target.close().catch(() => undefined);
      env.runtime.dispose();
      await fakes.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "expired key (401): new turn and resume fail only on the bound Provider; no fallback until reconfigured",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-stale-provider-401-"));
    const fakes = await startFakes();
    const env = await createHostEnvironment(root, fakes.origin);
    let target = env.makeTarget();
    try {
      const spec = env.specFor("expired-key-session", {
        providerId: env.staleId,
        modelId: "stale-model",
      });
      const originalBinding = structuredClone(spec.modelBinding);
      await target.create(spec);
      assert.equal((await send(target, spec, "turn-1", "remember me")).status, "accepted");
      await target.waitForIdle(spec);
      assert.deepEqual(assistantTexts(await target.eventsSince(spec, 0), "turn-1"), [
        "answer-from-stale",
      ]);

      // The Provider now rejects the stored key; the Registry still lists it unchanged.
      fakes.expiredKeys.add("stale-key-v1");
      assert.equal(
        (await send(target, spec, "turn-2", "continue after expiry")).status,
        "accepted",
      );
      await target.waitForIdle(spec);
      const afterExpiry = await target.eventsSince(spec, 0);
      assert.deepEqual(assistantTexts(afterExpiry, "turn-2"), []);
      assert.equal(
        turnEvents(afterExpiry, "turn-2").some(
          (event) => event.kind === "turn.finished" && event.outcome === "failed",
        ),
        true,
      );
      // Typed, key-free reconfigure signal on the session stream (not a generic pi-model-* code).
      const expectedFailure = {
        reason: "auth_failed",
        action: "reconfigure-provider",
        providerId: env.staleId,
        modelId: "stale-model",
        statusCode: 401,
        retryable: false,
      };
      const typedErrors = afterExpiry.filter(
        (event): event is Extract<AgentEvent, { kind: "session.error" }> =>
          event.kind === "session.error",
      );
      assert.equal(typedErrors.length, 1);
      assert.equal(typedErrors[0]?.code, "provider-reconfigure-required");
      assert.deepEqual(
        (typedErrors[0] as Record<string, unknown> | undefined)?.failure,
        expectedFailure,
      );
      assert.equal(typedErrors[0]?.message.includes(env.staleId), true);
      assert.equal(typedErrors[0]?.message.includes("401"), true);
      assert.equal(JSON.stringify(afterExpiry).includes("stale-key"), false);
      assert.equal(JSON.stringify(afterExpiry).includes("127.0.0.1"), false);
      assert.equal(
        (await target.snapshot(spec)).control.lastError?.code,
        "provider-reconfigure-required",
      );
      const failures = env.statuses.filter(
        (event): event is Extract<ModelNetworkStatusEvent, { type: "model_request_failed" }> =>
          event.type === "model_request_failed",
      );
      assert.equal(failures.length, 1);
      assert.equal(failures[0]?.providerId, env.staleId);
      assert.equal(failures[0]?.modelId, "stale-model");
      assert.equal(failures[0]?.statusCode, 401);
      assert.equal(failures[0]?.reason, "auth_failed");
      assert.equal(failures[0]?.errorCode, "provider_not_configured");
      assert.equal(failures[0]?.retryable, false);

      // Resume after restart: still bound to the same Provider, still no fallback.
      await target.close();
      target = env.makeTarget();
      await target.attach(spec);
      assert.equal((await send(target, spec, "turn-3", "resume after expiry")).status, "accepted");
      await target.waitForIdle(spec);
      const afterResume = await target.eventsSince(spec, 0);
      assert.deepEqual(assistantTexts(afterResume, "turn-3"), []);
      const resumeErrors = afterResume.filter((event) => event.kind === "session.error");
      assert.equal(resumeErrors.length, 2);
      assert.deepEqual(
        (resumeErrors[1] as Record<string, unknown> | undefined)?.failure,
        expectedFailure,
      );
      assert.equal(JSON.stringify(afterResume).includes("stale-key"), false);
      assert.deepEqual(fakes.requests, [
        { route: "stale", authorization: "Bearer stale-key-v1" },
        { route: "stale", authorization: "Bearer stale-key-v1" },
        { route: "stale", authorization: "Bearer stale-key-v1" },
      ]);
      assert.equal(fakes.count("other"), 0);
      assert.equal(
        env.statuses.some((event) => "providerId" in event && event.providerId === env.otherId),
        false,
      );
      assert.equal(
        env.createdModels.every(
          (model) => model.providerId === env.staleId && model.modelId === "stale-model",
        ),
        true,
      );
      const summary = (await target.listSessionSummaries("stale-workspace", env.worktree))[0];
      assert.deepEqual(summary?.spec.modelBinding, originalBinding);
      assert.equal(summary?.recentOutcome, "failed");

      // Reconfigure the key: the same session proceeds with exactly that Provider and key.
      await env.runtime.configService.savePersonalProviderOverlay(
        env.staleId,
        providerConfig(`${fakes.origin}/stale/v1`, "stale-key-v2"),
      );
      await env.runtime.registryService.refresh("user-rotated-key");
      assert.equal(
        (await send(target, spec, "turn-4", "continue with new key")).status,
        "accepted",
      );
      await target.waitForIdle(spec);
      assert.deepEqual(assistantTexts(await target.eventsSince(spec, 0), "turn-4"), [
        "answer-from-stale",
      ]);
      assert.deepEqual(fakes.requests.at(-1), {
        route: "stale",
        authorization: "Bearer stale-key-v2",
      });
      assert.equal(fakes.count("other"), 0);

      // Explicitly picking the other model is a new, separate binding; the old one is untouched.
      const picked = env.specFor("explicit-other-model", {
        providerId: env.otherId,
        modelId: "other-model",
      });
      await target.create(picked);
      assert.equal(
        (await send(target, picked, "turn-b", "use the model I picked")).status,
        "accepted",
      );
      await target.waitForIdle(picked);
      assert.deepEqual(assistantTexts(await target.eventsSince(picked, 0), "turn-b"), [
        "answer-from-other",
      ]);
      assert.deepEqual(
        fakes.requests.filter((request) => request.route === "other"),
        [{ route: "other", authorization: "Bearer other-key" }],
      );
      assert.equal(fakes.count("stale"), 4);
      const summaries = await target.listSessionSummaries("stale-workspace", env.worktree);
      assert.deepEqual(
        summaries.find((entry) => entry.spec.hostSessionId === spec.hostSessionId)?.spec
          .modelBinding,
        originalBinding,
      );
    } finally {
      await target.close().catch(() => undefined);
      env.runtime.dispose();
      await fakes.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test(
  "credential needs attention after 401: next turns on that Provider are refused before any request; others unaffected; reconfigure clears",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-stale-provider-attention-"));
    const fakes = await startFakes();
    const env = await createHostEnvironment(root, fakes.origin);
    const target = env.makeTarget();
    try {
      const spec = env.specFor("attention-session", {
        providerId: env.staleId,
        modelId: "stale-model",
      });
      const sibling = env.specFor("attention-sibling-session", {
        providerId: env.staleId,
        modelId: "stale-model",
      });
      const other = env.specFor("attention-other-session", {
        providerId: env.otherId,
        modelId: "other-model",
      });
      for (const created of [spec, sibling, other]) await target.create(created);
      assert.equal((await send(target, spec, "turn-1", "remember me")).status, "accepted");
      await target.waitForIdle(spec);
      assert.deepEqual(assistantTexts(await target.eventsSince(spec, 0), "turn-1"), [
        "answer-from-stale",
      ]);

      // The stored key expires: exactly one turn reaches the Provider and fails with 401.
      fakes.expiredKeys.add("stale-key-v1");
      assert.equal((await send(target, spec, "turn-2", "after expiry")).status, "accepted");
      await target.waitForIdle(spec);
      assert.equal(fakes.count("stale"), 2);
      const statusesAfter401 = env.statuses.length;
      const modelsAfter401 = env.createdModels.length;

      const expectedFailure = {
        reason: "auth_failed",
        action: "reconfigure-provider",
        providerId: env.staleId,
        modelId: "stale-model",
        statusCode: 401,
        retryable: false,
      };
      const assertRefused = async (
        session: SessionSpec,
        turn: string,
        failure: Record<string, unknown>,
      ) => {
        const receipt = await send(target, session, turn, "try again");
        assert.equal(receipt.status, "rejected");
        assert.equal(receipt.reasonCode, "provider-reconfigure-required");
        assert.deepEqual((receipt as Record<string, unknown>).failure, failure);
        assert.equal(receipt.message?.includes(env.staleId), true);
        assert.equal(receipt.message?.includes("401"), true);
        assert.equal(JSON.stringify(receipt).includes("stale-key"), false);
        assert.equal(JSON.stringify(receipt).includes("127.0.0.1"), false);
        assert.deepEqual(await target.queryCommand(session, `${turn}-command`), receipt);
        assert.deepEqual(turnEvents(await target.eventsSince(session, 0), turn), []);
      };

      // Next turn on the same session: refused at admission, zero extra Provider requests.
      await assertRefused(spec, "turn-3", expectedFailure);
      // Per Provider, not per session: a sibling session on the same Provider is refused too.
      await assertRefused(sibling, "sibling-1", expectedFailure);
      // Unrelated Registry change on that Provider (a new model) does not clear the state.
      await env.runtime.configService.addPersonalModel(env.staleId, "stale-model-2", modelConfig());
      await env.runtime.registryService.refresh("user-added-model");
      await assertRefused(spec, "turn-4", expectedFailure);
      assert.equal(fakes.count("stale"), 2);
      assert.equal(env.statuses.length, statusesAfter401);
      assert.equal(env.createdModels.length, modelsAfter401);

      // Another Provider is unaffected.
      assert.equal((await send(target, other, "other-1", "use the other one")).status, "accepted");
      await target.waitForIdle(other);
      assert.deepEqual(assistantTexts(await target.eventsSince(other, 0), "other-1"), [
        "answer-from-other",
      ]);
      assert.equal(fakes.count("other"), 1);
      assert.equal(fakes.count("stale"), 2);

      // Reconfiguring the credential clears the state: the next turn is admitted and reaches it.
      await env.runtime.configService.savePersonalProviderOverlay(
        env.staleId,
        providerConfig(`${fakes.origin}/stale/v1`, "stale-key-v2"),
      );
      await env.runtime.registryService.refresh("user-rotated-key");
      assert.equal((await send(target, spec, "turn-5", "with new key")).status, "accepted");
      await target.waitForIdle(spec);
      assert.deepEqual(assistantTexts(await target.eventsSince(spec, 0), "turn-5"), [
        "answer-from-stale",
      ]);
      assert.equal((await send(target, sibling, "sibling-2", "sibling again")).status, "accepted");
      await target.waitForIdle(sibling);
      assert.deepEqual(assistantTexts(await target.eventsSince(sibling, 0), "sibling-2"), [
        "answer-from-stale",
      ]);
      assert.deepEqual(
        fakes.requests.filter((request) => request.route === "stale"),
        [
          { route: "stale", authorization: "Bearer stale-key-v1" },
          { route: "stale", authorization: "Bearer stale-key-v1" },
          { route: "stale", authorization: "Bearer stale-key-v2" },
          { route: "stale", authorization: "Bearer stale-key-v2" },
        ],
      );
      assert.equal(fakes.count("other"), 1);
    } finally {
      await target.close().catch(() => undefined);
      env.runtime.dispose();
      await fakes.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("send receipt accepts an optional key-free reconfigure failure and stays strict", () => {
  const failure = {
    reason: "auth_failed",
    action: "reconfigure-provider",
    providerId: "p",
    modelId: "m",
    statusCode: 401,
    retryable: false,
  };
  const receipt = {
    commandId: "c",
    status: "rejected",
    reasonCode: "provider-reconfigure-required",
    message: "Provider p needs attention",
    failure,
  };
  assert.deepEqual(agentCommandReceiptSchema.parse(receipt), receipt);
  assert.throws(() =>
    agentCommandReceiptSchema.parse({ ...receipt, failure: { ...failure, apiKey: "k" } }),
  );
  assert.throws(() => agentCommandReceiptSchema.parse({ ...receipt, providerKey: "k" }));
});
