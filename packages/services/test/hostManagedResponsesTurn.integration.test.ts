import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ProviderRegistryService } from "@zcode/provider";
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
import {
  bindingPlanSchema,
  type ExecutionTarget,
  type SessionSpec,
} from "@zcode/shared/agent-host";
import type { ModelSelection } from "@zcode/shared/model-selection";
import { ClaudeCodeHarnessAdapter } from "../src/agent-adapters/claude-code/claudeCodeHarnessAdapter.js";
import { FakeClaudeCodeTransport } from "../src/agent-adapters/claude-code/claudeCodeFakeTransport.js";
import { CLAUDE_CODE_ADAPTER_VERSION } from "../src/agent-adapters/claude-code/claudeCodeVersion.js";
import { CodexHarnessAdapter } from "../src/agent-adapters/codex/codexHarnessAdapter.js";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";
import { bindHostModel } from "../src/agent-host/modelBinding.js";
import {
  ModelBindingPlanner,
  type ExistingModelExecutor,
  type ModelCatalogSnapshotPort,
} from "../src/agent-host/modelBindingPlanner.js";
import type { HarnessAdapter } from "../src/agent-host/harnessRegistry.js";
import { createModelGateway, MODEL_GATEWAY_VERSION } from "../src/model-gateway/index.js";

const FIXTURE_KEY = "fixture-only";
const PROVIDER_ID = "fixture-provider";
const MODEL_ID = "fixture-model";
const ANSWER = "fixture-responses-answer";
const sourceRevisions = { config: "fixture-config", account: "fixture-account" };
const selection: ModelSelection = {
  providerId: PROVIDER_ID,
  modelId: MODEL_ID,
  options: { reasoningLevel: "off" },
};

interface ProviderHit {
  readonly path: string;
  readonly authorization: string | undefined;
}

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
        map: '{"reasoning_effort":"none"}',
      }),
      maxOutputTokens: new LimitOptionSpecConfig({
        max: 256,
        map: '{"max_tokens": maxOutputTokens}',
      }),
    }),
  });
}

function registry(baseUrl: string): ProviderRegistryService {
  const providerConfig = new ProviderConfig({
    access: new ApiKeyAccessConfig({ apiKey: FIXTURE_KEY }),
    api: new ProviderApiConfig({ type: "openai-responses", baseUrl }),
  });
  const config = modelConfig();
  return {
    getSnapshot: () => ({ sourceRevisions }),
    validateSelection: () => ({ ok: true as const }),
    getProvider: () => ({ providerId: PROVIDER_ID, config: providerConfig }),
    getModel: () => ({ modelId: MODEL_ID, config }),
  } as unknown as ProviderRegistryService;
}

function catalog(): ModelCatalogSnapshotPort {
  return {
    fingerprint: JSON.stringify(sourceRevisions),
    validateSelection(next) {
      return next.providerId === PROVIDER_ID && next.modelId === MODEL_ID
        ? { ok: true }
        : { ok: false, reason: "model-not-found" };
    },
    credentialSource: () => "provider-api-key",
  };
}

function executor(): ExistingModelExecutor {
  return {
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    properties: { supportsToolCall: true, inputFormat: { supportsImage: false } },
    optionSpecs: { reasoningLevel: { values: ["off"] } },
    options: { reasoningLevel: "off" },
  };
}

function specFor(harness: HarnessAdapter): SessionSpec {
  return {
    schemaVersion: 1,
    hostSessionId: `host-${harness.id}-responses`,
    execution: {
      targetId: "local-responses",
      workspaceIdentity: "wave4-responses-workspace",
      worktreePath: "/tmp/wave4-responses-worktree",
    },
    harness: { id: harness.id, adapterVersion: harness.version },
    modelBinding: { kind: "host-managed", selection },
  };
}

function target(): ExecutionTarget {
  return {
    id: "local-responses",
    kind: "local",
    platform: process.platform as ExecutionTarget["platform"],
    available: true,
  };
}

function writeResponsesStream(response: ServerResponse, answer: string): void {
  const responseId = "resp_fixture";
  const messageId = "msg_fixture";
  const events = [
    {
      type: "response.created",
      response: { id: responseId, object: "response", status: "in_progress", output: [] },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: {
        id: messageId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [],
      },
    },
    {
      type: "response.content_part.added",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      delta: answer,
    },
    {
      type: "response.output_text.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      text: answer,
    },
    {
      type: "response.content_part.done",
      item_id: messageId,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: answer, annotations: [] },
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: {
        id: messageId,
        type: "message",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text: answer, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: responseId,
        object: "response",
        status: "completed",
        output: [
          {
            id: messageId,
            type: "message",
            status: "completed",
            role: "assistant",
            content: [{ type: "output_text", text: answer, annotations: [] }],
          },
        ],
        usage: { input_tokens: 2, output_tokens: 2, total_tokens: 4 },
      },
    },
  ];
  response.writeHead(200, { "content-type": "text/event-stream" });
  for (const event of events) {
    response.write(`event: ${event.type}\n`);
    response.write(`data: ${JSON.stringify(event)}\n\n`);
  }
  response.end();
}

function requestBody(): Record<string, unknown> {
  return {
    client_metadata: { session_id: "client-session", thread_id: "client-thread" },
    include: ["reasoning.encrypted_content"],
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] }],
    instructions: "wave4 fixture",
    model: MODEL_ID,
    parallel_tool_calls: true,
    prompt_cache_key: "fixture-cache-key",
    reasoning: { effort: "none" },
    store: false,
    stream: true,
    tool_choice: "auto",
    tools: [],
  };
}

function outputDeltas(raw: string): string {
  const deltas: string[] = [];
  for (const record of raw.split("\n\n")) {
    const dataLine = record.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) continue;
    try {
      const event = JSON.parse(dataLine.slice(6)) as { type?: string; delta?: string };
      if (event.type === "response.output_text.delta" && event.delta) deltas.push(event.delta);
    } catch {
      return raw;
    }
  }
  return deltas.join("");
}

async function runTurn(input: {
  readonly harness: HarnessAdapter;
  readonly registry: ProviderRegistryService;
  readonly adapter: AiSdkModelAdapter;
  readonly hits: ProviderHit[];
}): Promise<{ label: "execution-layer" | "experimental"; reason: string; outputText: string }> {
  const spec = specFor(input.harness);
  const planned = await new ModelBindingPlanner().plan({
    spec,
    target: target(),
    harness: input.harness,
    catalog: catalog(),
    executor: executor(),
    backgroundCalls: { support: "supported" },
    gatewayVersion: MODEL_GATEWAY_VERSION,
  });
  const wire = bindingPlanSchema.parse({
    schemaVersion: 1,
    hostSessionId: planned.hostSessionId,
    targetId: planned.targetId,
    harnessId: planned.harnessId,
    adapterVersion: planned.adapterVersion,
    catalogFingerprint: planned.catalogFingerprint,
    ...(planned.credentialSource ? { credentialSource: planned.credentialSource } : {}),
    requested: planned.requested,
    ...(planned.effective ? { effective: planned.effective } : {}),
    ...(planned.route ? { route: planned.route } : {}),
    ...(planned.credentialRef ? { credentialRef: planned.credentialRef } : {}),
    support: planned.support,
    capabilities: planned.capabilities,
  });
  if (
    planned.route !== "responses-gateway" ||
    planned.support.support !== "supported" ||
    planned.execution.kind !== "existing-model-runtime"
  ) {
    return {
      label: "experimental",
      outputText: "",
      reason:
        planned.support.reason ??
        `production hostManagedRoute ${input.harness.hostManagedRoute ?? "missing"} is not admitted by Gateway Responses`,
    };
  }
  const hitsBefore = input.hits.length;
  const model = input.harness.prepareModel
    ? await input.harness.prepareModel(spec, wire)
    : bindHostModel({ plan: wire, registry: input.registry, adapter: input.adapter });
  const gateway = createModelGateway({
    targetId: spec.execution.targetId,
    host: "127.0.0.1",
    port: 0,
  });
  const { baseUrl } = await gateway.start();
  try {
    const grant = gateway.createGrant({
      protocol: "openai-responses",
      sessionId: spec.hostSessionId,
      modelBindingFingerprint: wire.catalogFingerprint,
      publicModelId: MODEL_ID,
      model,
      plan: wire,
      expiresInMs: 60_000,
      limits: {
        maxBodyBytes: 4096,
        maxRequests: 4,
        maxConcurrent: 1,
        maxOutputTokens: 20,
        maxOutputTokensPerRequest: 8,
      },
    });
    const response = await fetch(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(requestBody()),
    });
    const raw = await response.text();
    const outputText = outputDeltas(raw);
    assert.equal(response.status, 200, raw);
    assert.equal(outputText, ANSWER);
    const providerHit = input.hits.slice(hitsBefore).at(-1);
    assert.ok(providerHit, "Gateway Responses did not call the model execution layer");
    assert.match(providerHit.path, /\/responses$/);
    assert.equal(providerHit.authorization, `Bearer ${FIXTURE_KEY}`);
    assert.equal(providerHit.authorization.includes(grant.token), false);
    return {
      label: "execution-layer",
      outputText,
      reason: "fixture provider only; control-plane capability is unchanged",
    };
  } finally {
    await gateway.close();
  }
}

test(
  "Pi、Codex、Claude 的 host-managed 只有打到执行层和 Responses Gateway 才算完成",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-responses-turn-"));
    const hits: ProviderHit[] = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        hits.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
        });
        if (!request.url?.includes("/responses")) {
          response.writeHead(404);
          response.end();
          return;
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? (JSON.parse(raw) as { stream?: boolean }) : {};
        if (body.stream === false) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              id: "resp_fixture",
              status: "completed",
              output: [
                {
                  id: "msg_fixture",
                  type: "message",
                  role: "assistant",
                  content: [{ type: "output_text", text: ANSWER, annotations: [] }],
                },
              ],
            }),
          );
          return;
        }
        writeResponsesStream(response, ANSWER);
      });
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const providerBaseUrl = `http://127.0.0.1:${port}/v1`;
    const modelRegistry = registry(providerBaseUrl);
    const adapter = new AiSdkModelAdapter({ streamIdleTimeoutMs: 5_000 });
    const executable = join(root, "codex");
    await mkdir(join(root, "codex-root"), { recursive: true });
    await writeFile(
      executable,
      "#!/usr/bin/env node\nprocess.stdout.write('codex-cli 0.157.1\\n');\n",
      {
        mode: 0o700,
      },
    );
    const bind = (_spec: SessionSpec, plan: Parameters<typeof bindHostModel>[0]["plan"]) =>
      bindHostModel({ plan, registry: modelRegistry, adapter });
    const pi = new PiHarnessAdapter({ root: join(root, "pi"), modelFactory: bind });
    const claudeHome = join(root, "claude-home");
    const claude = new ClaudeCodeHarnessAdapter({
      managedRoot: join(root, "claude-managed"),
      userHome: claudeHome,
      transport: new FakeClaudeCodeTransport({ userHome: claudeHome }),
      profileSink: { async writeMarker() {}, async removeProfile() {} },
    });
    const codex = new CodexHarnessAdapter({
      root: join(root, "codex-root"),
      executablePath: executable,
      isOpenAiResponsesSelection: (next) => next.providerId === PROVIDER_ID,
      fakeModelCompatibilityEvidence: (next) =>
        next.providerId === PROVIDER_ID && next.modelId === MODEL_ID
          ? { providerId: PROVIDER_ID, modelId: MODEL_ID, fixtureId: "wave4-responses-fixture" }
          : undefined,
      modelFactory: bind,
    });
    try {
      assert.equal(pi.hostManagedRoute, "pi-sdk");
      assert.equal(claude.hostManagedRoute, "messages-gateway");
      assert.equal(claude.version, CLAUDE_CODE_ADAPTER_VERSION);
      assert.equal(codex.hostManagedRoute, "responses-gateway");
      assert.equal(codex.version, "0.157.1");

      const piTurn = await runTurn({ harness: pi, registry: modelRegistry, adapter, hits });
      assert.equal(piTurn.label, "experimental");
      assert.match(piTurn.reason, /pi-sdk|not admitted|not certified/);
      assert.equal(hits.length, 0);

      const claudeTurn = await runTurn({ harness: claude, registry: modelRegistry, adapter, hits });
      assert.equal(claudeTurn.label, "experimental");
      assert.equal(claudeTurn.outputText, "");
      assert.equal(hits.length, 0);

      const codexTurn = await runTurn({ harness: codex, registry: modelRegistry, adapter, hits });
      assert.equal(codexTurn.label, "execution-layer");
      assert.equal(codexTurn.outputText, ANSWER);
      const capabilities = await codex.capabilities(target());
      assert.equal(capabilities.hostManagedModel?.support, "experimental");
    } finally {
      await codex.shutdown();
      await claude.shutdown();
      server.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
