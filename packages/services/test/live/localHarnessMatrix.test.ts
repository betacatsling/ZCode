import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { Model } from "@zcode/contracts";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelConfigRules,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  ProviderRegistryService,
  ProviderTemplateMap,
  parseAccountProviderConfigMap,
} from "@zcode/provider";
import type { AgentEvent, BindingPlan, SessionSpecV2 } from "@zcode/shared/agent-host";
import { PiHarnessAdapter } from "../../src/agent-adapters/pi/piHarnessAdapter.js";
import { captureHostModel } from "../../src/agent-host/modelBinding.js";

const enabled = process.env.ZCODE_LIVE_LOCAL_MATRIX === "1";
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 原因：native CLI 的现有 account overlay 只容纳账号权益，不接受 API Key；
// 不得为了在隔离 HOME 中运行而把现有 Pi 凭据写入 personal provider 配置文件。
test("native public account overlay refuses an API key provider", () => {
  assert.throws(() =>
    parseAccountProviderConfigMap({
      axonhub: { access: { type: "api-key", apiKey: "fixture-only-not-a-credential" } },
    }),
  );
});

test(
  "live axonhub/deepseek-v4-flash executor in isolated Pi v2 SDK: deny, approve, test, follow-up",
  { skip: !enabled, timeout: 240000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-live-matrix-local-"));
    const worktree = join(root, "worktree");
    let adapter: PiHarnessAdapter | undefined;
    let registry: ProviderRegistryService | undefined;
    let stage = "setup";
    const eventCounts = new Map<string, number>();
    const metadataShapes = new Set<string>();
    const events: AgentEvent[] = [];
    try {
      await mkdir(worktree, { mode: 0o700 });
      await writeFile(join(worktree, "input.txt"), "seed=violet\n");
      // 授权范围只包含现有本机账户；修复依据：不能把真实凭据注入 Pi worker 或测试日志。
      const existingPiHome = process.env.ZCODE_MATRIX_EXISTING_PI_HOME;
      assert.ok(
        existingPiHome,
        "existing local Pi home must be supplied separately from isolated HOME",
      );
      const settings = JSON.parse(
        await readFile(join(existingPiHome, ".pi/agent/models.json"), "utf8"),
      ) as {
        providers?: Record<
          string,
          { api: string; baseUrl: string; apiKey: string; models: { id: string }[] }
        >;
      };
      const configured = settings.providers?.axonhub;
      assert.equal(configured?.api, "anthropic-messages");
      assert.ok(configured.apiKey && configured.baseUrl);
      assert.ok(configured.models.some((item) => item.id === "deepseek-v4-flash"));
      const revision = "isolated-live-v2";
      registry = new ProviderRegistryService({
        configSource: {
          read: async () => ({
            revision,
            zcodeBuiltinRevision: revision,
            personalRevision: revision,
            zcodeBuiltinProviders: ProviderConfigMap.empty(),
            zcodeBuiltinProviderTemplates: new ProviderTemplateMap(),
            personalProviders: new ProviderConfigMap([
              [
                "axonhub",
                new ProviderConfig({
                  group: "standard-personal",
                  access: new ApiKeyAccessConfig({ apiKey: configured.apiKey }),
                  api: new ProviderApiConfig({ type: configured.api, baseUrl: configured.baseUrl }),
                  personalModelIds: ["deepseek-v4-flash"],
                }),
              ],
            ]),
            zcodeBuiltinModelRules: ModelConfigRules.empty(),
            personalModels: ModelConfigRules.empty().setExact(
              "axonhub",
              "deepseek-v4-flash",
              ModelConfig.fromData({
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
              }),
            ),
          }),
          onDidChange: () => () => {},
        },
        accountSource: {
          read: async () => ({
            revision: "none",
            basedOnZCodeBuiltinRevision: revision,
            providers: ProviderConfigMap.empty(),
          }),
          onDidChange: () => () => {},
        },
      });
      await registry.start();
      const spec: SessionSpecV2 = {
        schemaVersion: 2,
        hostSessionId: randomUUID(),
        projectId: "isolated-project",
        workspaceId: "isolated-workspace",
        execution: {
          targetId: "local",
          workspaceIdentity: `live-${randomUUID()}`,
          worktreePath: worktree,
          worktreeGeneration: randomUUID(),
          cwdRelativeToWorktree: ".",
        },
        harness: { id: "pi", adapterVersion: "0.87.1" },
        modelBinding: {
          kind: "host-managed",
          selection: {
            providerId: "axonhub",
            modelId: "deepseek-v4-flash",
            options: { reasoningLevel: "off" },
          },
        },
      };
      const plan: BindingPlan = {
        schemaVersion: 1,
        hostSessionId: spec.hostSessionId,
        targetId: "local",
        harnessId: "pi",
        adapterVersion: "0.87.1",
        catalogFingerprint: JSON.stringify(registry.getSnapshot()!.sourceRevisions),
        requested: spec.modelBinding,
        effective: spec.modelBinding.selection,
        route: "pi-sdk",
        support: { support: "supported" },
        capabilities: {},
      };
      const executor = new AiSdkModelAdapter({ retry: { maxRetries: 0 } });
      let modelCalls = 0;
      adapter = new PiHarnessAdapter({
        root: join(root, "workers"),
        modelFactory: () => {
          const captured = captureHostModel({ plan, registry: registry!, adapter: executor });
          return {
            ...captured,
            model: new Proxy(captured.model, {
              get(target, property, receiver) {
                if (property !== "streamText") return Reflect.get(target, property, receiver);
                return async function* (request: Parameters<Model["streamText"]>[0]) {
                  modelCalls++;
                  for await (const event of target.streamText(request)) {
                    eventCounts.set(event.type, (eventCounts.get(event.type) ?? 0) + 1);
                    if (
                      "providerMetadata" in event &&
                      event.providerMetadata &&
                      typeof event.providerMetadata === "object"
                    ) {
                      metadataShapes.add(
                        `${event.type}:${Object.entries(event.providerMetadata)
                          .map(([key, value]) => `${key}:${typeof value}`)
                          .sort()
                          .join(",")}`,
                      );
                    }
                    yield event;
                  }
                };
              },
            }),
          };
        },
      });
      const binding = await adapter.create(spec, plan);
      adapter.subscribe(spec.hostSessionId, (event) => events.push(event));
      const count = (kind: AgentEvent["kind"]) =>
        events.filter((event) => event.kind === kind).length;
      const wait = async (
        kind: AgentEvent["kind"],
        index: number,
        maxMs = 55000,
      ): Promise<AgentEvent> => {
        const deadline = Date.now() + maxMs;
        while (Date.now() < deadline) {
          const found = events.filter((event) => event.kind === kind)[index];
          if (found) return found;
          if (events.some((event) => event.kind === "session.error")) break;
          await delay(50);
        }
        throw new Error(
          `stage=${stage}; missing=${kind}; errors=${events
            .filter((e) => e.kind === "session.error")
            .map((e) => (e.kind === "session.error" ? e.code : ""))
            .join(",")}`,
        );
      };
      const send = async (turnId: string, text: string) => {
        await adapter!.prepareTurn(spec, { turnId, runtimeEpoch: binding.runtimeEpoch, plan });
        return adapter!.send({
          type: "send",
          commandId: randomUUID(),
          hostSessionId: spec.hostSessionId,
          turnId,
          text,
        });
      };
      const resolve = (turnId: string, interactionId: string, decision: "allow" | "deny") =>
        adapter!.resolveInteraction({
          type: "resolveInteraction",
          commandId: randomUUID(),
          hostSessionId: spec.hostSessionId,
          runtimeEpoch: binding.runtimeEpoch,
          turnId,
          interactionId,
          decision,
        });
      stage = "denied-write";
      const denied = send(
        "denied",
        "Use the write tool now to create denied.txt containing forbidden. Do not use read or bash first; wait for the write approval.",
      );
      const denial = await wait("interaction.requested", 0);
      assert.equal(denial.kind, "interaction.requested");
      assert.match(denial.summary, /Allow Pi write/);
      await resolve("denied", denial.interactionId, "deny");
      await denied;
      await wait("turn.finished", 0);
      await assert.rejects(readFile(join(worktree, "denied.txt")), { code: "ENOENT" });
      stage = "approved-write-bash";
      const approved = send(
        "approved",
        "Read input.txt. Use the write tool to create output.txt containing exactly seed=violet, then use bash tool to run 'test -f output.txt && grep -q violet output.txt'. Do not write with bash.",
      );
      let approvedCount = 0;
      const approvedDeadline = Date.now() + 105000;
      while (count("turn.finished") < 2 && Date.now() < approvedDeadline) {
        const pending = events
          .filter(
            (event): event is Extract<AgentEvent, { kind: "interaction.requested" }> =>
              event.kind === "interaction.requested",
          )
          .slice(1 + approvedCount);
        for (const interaction of pending) {
          assert.equal(interaction.turnId, "approved");
          await resolve("approved", interaction.interactionId, "allow");
          approvedCount++;
        }
        if (events.some((event) => event.kind === "session.error")) break;
        await delay(50);
      }
      if (count("turn.finished") < 2 || events.some((event) => event.kind === "session.error"))
        throw new Error("approved turn did not settle successfully");
      await approved;
      assert.equal(await readFile(join(worktree, "output.txt"), "utf8"), "seed=violet");
      const successes = events
        .filter(
          (event): event is Extract<AgentEvent, { kind: "tool.finished" }> =>
            event.kind === "tool.finished" && event.outcome === "success",
        )
        .map((event) => event.name);
      for (const tool of ["read", "write", "bash"])
        assert.ok(successes.includes(tool), `${tool} tool missing`);
      stage = "follow-up";
      await send("followup", "Read output.txt and state its seed value without modifying files.");
      const finish = await wait("turn.finished", 2);
      assert.equal(finish.kind, "turn.finished");
      assert.equal(finish.outcome, "success");
      assert.ok(
        events.some(
          (event) =>
            event.kind === "message.finished" &&
            event.role === "assistant" &&
            /violet/.test(event.text),
        ),
      );
      stage = "stop";
      await adapter.terminate(spec.hostSessionId);
      await assert.rejects(resolve("approved", denial.interactionId, "allow"), /not attached/);
      console.log(
        `live-local-matrix-pi-axonhub pass: modelCalls=${modelCalls} approvals=${count("interaction.requested")} turns=${count("turn.finished")} successfulTools=${successes.join(",")}`,
      );
    } catch (error) {
      // 修复：SDK 异常可能携带请求或供应商信息；失败仅输出阶段、安全码及事件形状。
      const rawCode = (error as { code?: unknown })?.code;
      const safeCode =
        typeof rawCode === "string" && /^[A-Z][A-Z0-9_]{0,40}$/.test(rawCode)
          ? rawCode
          : "UNCLASSIFIED";
      console.log(
        `live-local-matrix-pi-axonhub failed stage=${stage} code=${safeCode} modelEvents=${JSON.stringify(Object.fromEntries(eventCounts))} metadataShapes=${JSON.stringify([...metadataShapes])} eventKinds=${JSON.stringify(events.map((event) => (event.kind === "session.error" ? `session.error:${event.code}` : event.kind)))}`,
      );
      throw new Error(`live local matrix Pi axonhub failed at ${stage}; see redacted event shape`);
    } finally {
      await adapter?.shutdown();
      registry?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);
