import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
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
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { PiHarnessAdapter } from "../src/agent-adapters/pi/piHarnessAdapter.js";
import type {
  ModelCatalogPort,
  ModelCatalogSnapshotPort,
} from "../src/agent-host/modelBindingPlanner.js";
import type { ModelSelection } from "@zcode/shared/model-selection";
import type { BindingPlan } from "@zcode/shared/agent-host";

interface Route {
  readonly providerId: string;
  readonly modelId: string;
  readonly baseUrl: string;
  readonly fakeKey: string;
  readonly answer: string;
}

interface CapturedRequest {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: Record<string, unknown>;
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

function providerConfig(route: Route): ProviderConfig {
  return new ProviderConfig({
    access: new ApiKeyAccessConfig({ apiKey: route.fakeKey }),
    api: new ProviderApiConfig({
      type: "openai-chat-completions",
      baseUrl: route.baseUrl,
    }),
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function sendChatCompletion(response: ServerResponse, answer: string): void {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(
    `data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: null }] })}\n\n`,
  );
  response.write(
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 2 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

test(
  "Pi worker freezes each Host turn route, replans after catalog updates, and keeps per-session history",
  { timeout: 30_000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-pi-turn-binding-"));
    const worktree = join(root, "worktree");
    await mkdir(worktree, { recursive: true });
    const requests: CapturedRequest[] = [];
    const firstRouteStarted = deferred<void>();
    const releaseFirstRoute = deferred<void>();
    let holdFirstRoute = true;
    const server = createServer((request, response) => {
      let raw = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        raw += chunk;
      });
      request.on("end", () => {
        const body = JSON.parse(raw) as Record<string, unknown>;
        requests.push({
          path: request.url ?? "",
          authorization: request.headers.authorization,
          body,
        });
        const routePath = request.url?.split("/")[1];
        const route = routes.get(routePath ?? "");
        if (!route) {
          response.writeHead(404);
          response.end();
          return;
        }
        if (routePath === "a-v1" && holdFirstRoute) {
          holdFirstRoute = false;
          firstRouteStarted.resolve();
          void releaseFirstRoute.promise.then(() => sendChatCompletion(response, route.answer));
          return;
        }
        sendChatCompletion(response, route.answer);
      });
    });
    const routes = new Map<string, Route>();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    const routeA1: Route = {
      providerId: "provider-a",
      modelId: "model-a",
      baseUrl: `${origin}/a-v1/v1`,
      fakeKey: "fake-key-a-v1",
      answer: "A route version one answer",
    };
    const routeA2: Route = {
      ...routeA1,
      baseUrl: `${origin}/a-v2/v1`,
      fakeKey: "fake-key-a-v2",
      answer: "A route version two answer",
    };
    const routeB: Route = {
      providerId: "provider-b",
      modelId: "model-b",
      baseUrl: `${origin}/b-v1/v1`,
      fakeKey: "fake-key-b",
      answer: "B independent answer",
    };
    routes.set("a-v1", routeA1);
    routes.set("a-v2", routeA2);
    routes.set("b-v1", routeB);
    let revision = 1;
    let providerARoute = routeA1;
    let providerAValid = true;
    let bindings = 0;
    const adapter = new AiSdkModelAdapter({ streamIdleTimeoutMs: 5_000 });
    const catalog: ModelCatalogPort = {
      get fingerprint() {
        return JSON.stringify({ revision });
      },
      validateSelection(selection) {
        if (selection.providerId === "provider-a")
          return providerAValid && selection.modelId === "model-a"
            ? { ok: true }
            : { ok: false, reason: "provider-a-model-unavailable" };
        return selection.providerId === "provider-b" && selection.modelId === "model-b"
          ? { ok: true }
          : { ok: false, reason: "provider-b-model-unavailable" };
      },
      capture(): ModelCatalogSnapshotPort {
        const capturedRevision = revision;
        const capturedARoute = providerARoute;
        const capturedAValid = providerAValid;
        const validate = (selection: ModelSelection) => {
          if (selection.providerId === "provider-a")
            return capturedAValid && selection.modelId === "model-a"
              ? { ok: true as const }
              : { ok: false as const, reason: "provider-a-model-unavailable" };
          return selection.providerId === "provider-b" && selection.modelId === "model-b"
            ? { ok: true as const }
            : { ok: false as const, reason: "provider-b-model-unavailable" };
        };
        return {
          fingerprint: JSON.stringify({ revision: capturedRevision }),
          validateSelection: validate,
          isCurrent: () => revision === capturedRevision,
          credentialSource: () => "provider-api-key",
          bindModel(plan: BindingPlan) {
            bindings += 1;
            const selection = plan.effective!;
            const route = selection.providerId === "provider-a" ? capturedARoute : routeB;
            return adapter.createModel({
              providerId: route.providerId,
              modelId: route.modelId,
              providerConfig: providerConfig(route) as never,
              modelConfig: modelConfig() as never,
              options: { reasoningLevel: "off" },
            });
          },
        };
      },
    };
    const harnesses = new HarnessRegistry();
    harnesses.register(
      new PiHarnessAdapter({
        root: join(root, "workers"),
        modelFactory: () => {
          throw new Error("the captured ModelCatalog must own production binding in this test");
        },
      }),
    );
    const target = {
      id: "local-target",
      kind: "local" as const,
      platform: process.platform as "darwin" | "linux",
      available: true,
    };
    const specA = {
      schemaVersion: 1 as const,
      hostSessionId: "pi-session-a",
      execution: {
        targetId: target.id,
        workspaceIdentity: "same-worktree",
        worktreePath: worktree,
      },
      harness: { id: "pi", adapterVersion: "0.87.1" },
      modelBinding: {
        kind: "host-managed" as const,
        selection: {
          providerId: "provider-a",
          modelId: "model-a",
          options: { reasoningLevel: "off" },
        },
      },
    };
    const specB = {
      ...specA,
      hostSessionId: "pi-session-b",
      modelBinding: {
        kind: "host-managed" as const,
        selection: {
          providerId: "provider-b",
          modelId: "model-b",
          options: { reasoningLevel: "off" },
        },
      },
    };
    let hostA: SessionHost | undefined;
    let hostB: SessionHost | undefined;
    try {
      hostA = await SessionHost.create({
        root: join(root, "journals"),
        spec: specA,
        target,
        registry: harnesses,
        catalog,
      });
      hostB = await SessionHost.create({
        root: join(root, "journals"),
        spec: specB,
        target,
        registry: harnesses,
        catalog,
      });
      const firstA = await hostA.dispatch({
        type: "send",
        commandId: "a-send-one",
        hostSessionId: specA.hostSessionId,
        turnId: "a-turn-one",
        text: "Remember the first route answer.",
      });
      assert.equal(firstA.status, "accepted");
      await firstRouteStarted.promise;

      // The accepted turn keeps its route snapshot while a same-worktree session uses another intent.
      providerARoute = routeA2;
      revision += 1;
      const secondSessionSend = await hostB.dispatch({
        type: "send",
        commandId: "b-send-one",
        hostSessionId: specB.hostSessionId,
        turnId: "b-turn-one",
        text: "Use provider B only.",
      });
      assert.equal(secondSessionSend.status, "accepted");
      await hostB.whenIdle();
      releaseFirstRoute.resolve();
      await hostA.whenIdle();

      const duplicateBindings = bindings;
      const duplicateRequests = requests.length;
      assert.equal(
        (
          await hostA.dispatch({
            type: "send",
            commandId: "a-send-one",
            hostSessionId: specA.hostSessionId,
            turnId: "a-turn-one",
            text: "Remember the first route answer.",
          })
        ).status,
        "duplicate",
      );
      assert.equal(bindings, duplicateBindings);
      assert.equal(requests.length, duplicateRequests);

      const secondA = await hostA.dispatch({
        type: "send",
        commandId: "a-send-two",
        hostSessionId: specA.hostSessionId,
        turnId: "a-turn-two",
        text: "Continue with the answer from the prior turn.",
      });
      assert.equal(secondA.status, "accepted");
      await hostA.whenIdle();

      const aV1 = requests.filter((request) => request.path.startsWith("/a-v1/"));
      const aV2 = requests.filter((request) => request.path.startsWith("/a-v2/"));
      const bV1 = requests.filter((request) => request.path.startsWith("/b-v1/"));
      assert.equal(aV1.length, 1);
      assert.equal(aV2.length, 1);
      assert.equal(bV1.length, 1);
      assert.equal(aV1[0]?.authorization, "Bearer fake-key-a-v1");
      assert.equal(aV2[0]?.authorization, "Bearer fake-key-a-v2");
      assert.equal(bV1[0]?.authorization, "Bearer fake-key-b");
      assert.equal(
        JSON.stringify(aV2[0]?.body.messages).includes("A route version one answer"),
        true,
        "the real Pi SDK next turn must include its earlier assistant context",
      );
      assert.equal(
        JSON.stringify(aV2[0]?.body.messages).includes("Remember the first route answer."),
        true,
      );
      assert.equal(
        JSON.stringify(bV1[0]?.body.messages).includes("Remember the first route answer."),
        false,
      );
      const firstFact = hostA.queryBindingFact("a-send-one");
      const secondFact = hostA.queryBindingFact("a-send-two");
      assert.equal(firstFact?.catalogFingerprint, JSON.stringify({ revision: 1 }));
      assert.equal(secondFact?.catalogFingerprint, JSON.stringify({ revision: 2 }));
      assert.equal(firstFact?.credentialSource, "provider-api-key");
      assert.equal(JSON.stringify(firstFact).includes("fake-key"), false);
      assert.equal(JSON.stringify(firstFact).includes("127.0.0.1"), false);

      providerAValid = false;
      revision += 1;
      const beforeRejected = requests.length;
      const invalid = await hostA.dispatch({
        type: "send",
        commandId: "a-send-invalid",
        hostSessionId: specA.hostSessionId,
        turnId: "a-turn-invalid",
        text: "This must be rejected before reaching the Model executor.",
      });
      assert.equal(invalid.status, "rejected");
      assert.equal(requests.length, beforeRejected);
      assert.equal(hostA.queryBindingFact("a-send-invalid"), undefined);
    } finally {
      releaseFirstRoute.resolve();
      await Promise.allSettled(
        [hostA, hostB]
          .filter((host): host is SessionHost => host !== undefined)
          .map((host) =>
            host.dispatch({
              type: "terminateSession",
              commandId: `cleanup-${host.spec.hostSessionId}`,
              hostSessionId: host.spec.hostSessionId,
            }),
          ),
      );
      await Promise.allSettled([hostA?.close(), hostB?.close()].filter(Boolean));
      server.close();
      await once(server, "close");
      await rm(root, { recursive: true, force: true });
    }
  },
);
