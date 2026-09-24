import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import {
  ModelConfig,
  ModelConfigRules,
  ProviderConfig,
  ProviderConfigMap,
  ProviderApiConfig,
  ApiKeyAccessConfig,
  ProviderTemplateMap,
  ProviderRegistryService,
} from "@zcode/provider";
import { HarnessRegistry } from "../../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../../src/agent-host/sessionHost.js";
import { createRegistryModelCatalog } from "../../src/agent-host/registryCatalog.js";
import { PiHarnessAdapter } from "../../src/agent-adapters/pi/piHarnessAdapter.js";
import type { Model } from "@zcode/contracts";
import { bindHostModel } from "../../src/agent-host/modelBinding.js";

const enabled = process.env.ZCODE_LIVE_STEPFUN === "1";

test(
  "real StepFun provider and Pi SDK: isolated read/edit/test/followup and denied write",
  { skip: !enabled, timeout: 240000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-live-stepfun-"));
    const worktree = join(root, "sample");
    let host: SessionHost | undefined;
    let registry: ProviderRegistryService | undefined;
    try {
      await mkdir(worktree, { mode: 0o700 });
      await writeFile(join(worktree, "input.txt"), "seed=violet\n");
      // Read only within this host process. Never send this configuration to a worker, fixture or logger.
      const settings = JSON.parse(
        await readFile(join(homedir(), ".pi/agent/models.json"), "utf8"),
      ) as {
        providers?: Record<
          string,
          { api: string; baseUrl: string; apiKey: string; models: { id: string }[] }
        >;
      };
      const configured = settings.providers?.stepfun;
      assert.equal(configured?.api, "anthropic-messages");
      assert.ok(configured.apiKey && configured.baseUrl);
      const modelId = "step-3.5-flash";
      assert.ok(configured.models.some((item) => item.id === modelId));
      const providerId = "stepfun";
      const config = new ProviderConfig({
        group: "standard-personal",
        access: new ApiKeyAccessConfig({ apiKey: configured.apiKey }),
        api: new ProviderApiConfig({ type: configured.api, baseUrl: configured.baseUrl }),
        personalModelIds: [modelId],
      });
      const modelConfig = ModelConfig.fromData({
        enabled: true,
        properties: {
          requiresMfjsToolSchema: false,
          contextWindow: 65536,
          inputFormat: {
            supportsText: true,
            supportsImage: false,
            supportsVideo: false,
            supportsAudio: false,
            supportsPdf: false,
          },
          outputFormat: { supportsText: true },
          supportsToolCall: true,
          supportsJsonSchemaOutput: false,
          supportsNativeWebSearch: false,
          supportsMidConversationSystem: true,
        },
        optionSpecs: {
          reasoningLevel: { values: ["off"], map: "{}" },
          maxOutputTokens: { max: 2048, map: "{}" },
        },
      });
      const personalProviders = new ProviderConfigMap([[providerId, config]]);
      const personalModels = ModelConfigRules.empty().setExact(providerId, modelId, modelConfig);
      const builtinRevision = "isolated-live-v1";
      registry = new ProviderRegistryService({
        configSource: {
          read: async () => ({
            revision: builtinRevision,
            zcodeBuiltinRevision: builtinRevision,
            personalRevision: builtinRevision,
            zcodeBuiltinProviders: ProviderConfigMap.empty(),
            zcodeBuiltinProviderTemplates: new ProviderTemplateMap(),
            personalProviders,
            zcodeBuiltinModelRules: ModelConfigRules.empty(),
            personalModels,
          }),
          onDidChange: () => () => {},
        },
        accountSource: {
          read: async () => ({
            revision: "none",
            basedOnZCodeBuiltinRevision: builtinRevision,
            providers: ProviderConfigMap.empty(),
          }),
          onDidChange: () => () => {},
        },
      });
      await registry.start();
      const selection = { providerId, modelId, options: { reasoningLevel: "off" } };
      const adapter = new AiSdkModelAdapter({ retry: { maxRetries: 0 } });
      const spec = {
        schemaVersion: 1 as const,
        hostSessionId: randomUUID(),
        execution: {
          targetId: "local",
          workspaceIdentity: `live-${randomUUID()}`,
          worktreePath: worktree,
        },
        harness: { id: "pi", adapterVersion: "0.87.1" },
        modelBinding: { kind: "host-managed" as const, selection },
      };
      const target = {
        id: "local",
        kind: "local" as const,
        platform: process.platform as "darwin" | "linux",
        available: true,
      };
      const harnesses = new HarnessRegistry();
      harnesses.register(
        new PiHarnessAdapter({
          root: join(root, "workers"),
          modelFactory: (_spec, plan) => {
            const model = bindHostModel({ plan, registry: registry!, adapter });
            return new Proxy(model, {
              get(target, property, receiver) {
                if (property !== "streamText") return Reflect.get(target, property, receiver);
                return async function* (request: Parameters<Model["streamText"]>[0]) {
                  const types: string[] = [];
                  try {
                    for await (const event of target.streamText(request)) {
                      types.push(
                        event.type === "finish" ? `finish:${event.finishReason}` : event.type,
                      );
                      yield event;
                    }
                  } catch (error) {
                    console.log(
                      `worker-model-error-class=${error instanceof Error ? error.constructor.name : typeof error}`,
                    );
                    throw error;
                  } finally {
                    console.log(`worker-model-event-types=${types.join(",")}`);
                  }
                };
              },
            });
          },
        }),
      );
      host = await SessionHost.create({
        root: join(root, "journals"),
        spec,
        target,
        catalog: createRegistryModelCatalog(registry),
        registry: harnesses,
      });
      assert.equal(host.plan.route, "pi-sdk");
      assert.deepEqual(
        host.plan.requested.kind === "host-managed" && host.plan.requested.selection,
        host.plan.effective,
      );
      const bound = bindHostModel({ plan: host.plan, registry, adapter });
      let calls = 0;
      const usage: string[] = [];
      for await (const event of bound.streamText({
        messages: [{ role: "user", content: "Reply with exactly: READY" }],
        options: { reasoningLevel: "off", maxOutputTokens: 100 },
      })) {
        if (event.type === "start") calls++;
        if (event.type === "finish")
          usage.push(
            `${event.finishReason}:${event.usage?.inputTokens ?? 0}/${event.usage?.outputTokens ?? 0}`,
          );
      }
      assert.equal(calls, 1);
      assert.ok(
        usage.some((value) => value.startsWith("stop:")),
        "real smoke must finish normally",
      );
      console.log(
        `route=${providerId}/${modelId} via anthropic-messages -> pi-sdk smoke=${usage.join(",")}`,
      );
      const pending: Array<{ id: string; summary: string }> = [];
      const eventKinds: string[] = [];
      const successfulTools: string[] = [];
      const turnOutcomes: string[] = [];
      host.subscribe((event) => {
        eventKinds.push(
          event.kind === "session.error" ? `session.error:${event.code}` : event.kind,
        );
        if (event.kind === "interaction.requested")
          pending.push({ id: event.interactionId, summary: event.summary });
        if (event.kind === "tool.finished" && event.outcome === "success")
          successfulTools.push(event.name);
        if (event.kind === "turn.finished") turnOutcomes.push(event.outcome);
      });
      const wait = async (count: number) => {
        const deadline = Date.now() + 55000;
        while (pending.length < count && Date.now() < deadline) {
          assert.ok(
            !eventKinds.some((kind) => kind.startsWith("session.error:")),
            `model failed before approval; kinds=${eventKinds.join(",")}`,
          );
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.ok(
          pending.length >= count,
          `expected approval ${count}; kinds=${eventKinds.join(",")}`,
        );
      };
      const send = async (turnId: string, text: string) =>
        host!.dispatch({
          type: "send",
          commandId: randomUUID(),
          hostSessionId: spec.hostSessionId,
          turnId,
          text,
        });
      const resolve = async (turnId: string, interactionId: string, decision: "allow" | "deny") =>
        host!.dispatch({
          type: "resolveInteraction",
          commandId: randomUUID(),
          hostSessionId: spec.hostSessionId,
          runtimeEpoch: host!.binding.runtimeEpoch,
          turnId,
          interactionId,
          decision,
        });
      await send(
        "denied",
        "Read input.txt, then use the write tool to create denied.txt containing forbidden. Do not use bash for writing.",
      );
      await wait(1);
      assert.match(pending[0]!.summary, /Allow Pi write/);
      await resolve("denied", pending[0]!.id, "deny");
      await host.whenIdle();
      await assert.rejects(readFile(join(worktree, "denied.txt")), { code: "ENOENT" });
      await send(
        "edit",
        "Read input.txt. Use write tool to create output.txt containing exactly seed=violet, then use bash tool to run 'test -f output.txt && grep -q violet output.txt'. Do not write with bash.",
      );
      const deadline = Date.now() + 105000;
      let approved = 1;
      while (Date.now() < deadline) {
        if (pending.length > approved) {
          await resolve("edit", pending[approved]!.id, "allow");
          approved++;
        }
        if (eventKinds.some((kind) => kind.startsWith("session.error:"))) break;
        if (eventKinds.filter((kind) => kind === "turn.finished").length >= 2 && approved > 1)
          break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await host.whenIdle();
      assert.match(await readFile(join(worktree, "output.txt"), "utf8"), /seed=violet/);
      assert.ok(successfulTools.includes("read"), "sample input must be read");
      assert.ok(successfulTools.includes("write"), "output must be written by Pi tool");
      assert.ok(successfulTools.includes("bash"), "test command must succeed");
      assert.equal(turnOutcomes[1], "success");
      await send(
        "followup",
        "Read output.txt and tell me the seed value, without modifying files.",
      );
      await host.whenIdle();
      assert.equal(turnOutcomes[2], "success");
      assert.ok(
        host
          .snapshot()
          .rows.window.some((row) => row.kind === "assistantText" && /violet/.test(row.text)),
        "second turn must answer using retained file context",
      );
      console.log(
        `pi approvalCount=${pending.length} outcomes=${turnOutcomes.join(",")} events=${eventKinds.join(",")}`,
      );
      await host.dispatch({
        type: "terminateSession",
        commandId: randomUUID(),
        hostSessionId: spec.hostSessionId,
      });
      await host.close();
      host = undefined;
    } finally {
      if (host) {
        try {
          await host.dispatch({
            type: "terminateSession",
            commandId: randomUUID(),
            hostSessionId: host.spec.hostSessionId,
          });
          await host.close();
        } catch {
          /* isolated process cleanup */
        }
      }
      registry?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
