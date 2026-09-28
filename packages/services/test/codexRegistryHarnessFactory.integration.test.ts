import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { ProviderRegistryService } from "@zcode/provider";
import { createExperimentalRegistryCodexHarness } from "../src/agent-adapters/codex/createCodexHarness.js";
import { HarnessRegistry } from "../src/agent-host/harnessRegistry.js";
import { bindHostModel } from "../src/agent-host/modelBinding.js";
import type { ModelCatalogPort } from "../src/agent-host/modelBindingPlanner.js";
import { SessionHost } from "../src/agent-host/sessionHost.js";
import { createCodexHarnessFakeModel } from "./fixtures/codexHarnessFakeModel.js";

const PINNED_CLI_TEST = process.env.ZCODE_CODEX_ADAPTER_TEST === "1";

test(
  "experimental registry factory uses bindHostModel for a frozen Responses plan",
  { skip: !PINNED_CLI_TEST },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "zcode-codex-registry-factory-"));
    const worktree = join(root, "workspace");
    await mkdir(worktree, { recursive: true, mode: 0o700 });
    const fake = createCodexHarnessFakeModel({
      allow: join(root, "unused-allow.txt"),
      deny: join(root, "unused-deny.txt"),
    });
    const sourceRevisions = { config: "fake-config-v1", account: "fake-account-v1" };
    const registry = {
      getSnapshot: () => ({ sourceRevisions }),
      validateSelection: () => ({ ok: true as const }),
      getProvider: () => ({
        providerId: "fake-provider",
        config: {
          access: { type: "api-key", apiKey: "fixture-only-never-sent" },
          api: { type: "openai-responses", baseUrl: "http://127.0.0.1:9/v1" },
        },
        models: [],
      }),
      getModel: () => ({
        modelId: "fake-model",
        config: { properties: { supportsJsonSchemaOutput: false } },
      }),
    } as unknown as ProviderRegistryService;
    const created: Array<{ providerId: string; modelId: string }> = [];
    const modelAdapter = {
      createModel(input: { providerId: string; modelId: string }) {
        created.push({ providerId: input.providerId, modelId: input.modelId });
        return fake.model;
      },
    } as unknown as AiSdkModelAdapter;
    const harness = createExperimentalRegistryCodexHarness({
      root: join(root, "adapter-data"),
      registry,
      executablePath: process.env.ZCODE_CODEX_EXECUTABLE,
      adapter: modelAdapter,
      fakeModelCompatibilityEvidence: (selection) =>
        selection.providerId === "fake-provider" && selection.modelId === "fake-model"
          ? {
              providerId: "fake-provider",
              modelId: "fake-model",
              fixtureId: "codex-registry-fake-model",
            }
          : undefined,
    });
    const registryOfHarnesses = new HarnessRegistry();
    registryOfHarnesses.register(harness);
    const workspaceSpec = {
      schemaVersion: 1 as const,
      hostSessionId: "codex-registry-factory-session",
      execution: {
        targetId: "codex-factory-target",
        workspaceIdentity: "factory-workspace",
        worktreePath: worktree,
      },
      harness: { id: "codex", adapterVersion: "0.157.1" },
      modelBinding: {
        kind: "host-managed" as const,
        selection: {
          providerId: "fake-provider" as never,
          modelId: "fake-model" as never,
          options: { reasoningLevel: "off" },
        },
      },
    };
    const target = {
      id: "codex-factory-target",
      kind: "local" as const,
      platform: process.platform as "darwin" | "linux" | "win32",
      available: true,
    };
    const unverifiedHarness = createExperimentalRegistryCodexHarness({
      root: join(root, "unverified-adapter-data"),
      registry,
      executablePath: process.env.ZCODE_CODEX_EXECUTABLE,
      adapter: modelAdapter,
    });
    const unverifiedReport = await unverifiedHarness.hostManagedSupport(
      target,
      workspaceSpec.modelBinding.selection,
    );
    assert.equal(unverifiedReport.support, "experimental");
    await unverifiedHarness.shutdown();
    const catalog: ModelCatalogPort = {
      get fingerprint() {
        return JSON.stringify(sourceRevisions);
      },
      validateSelection: () => ({ ok: true as const }),
      capture() {
        const revisions = { ...sourceRevisions };
        const fingerprint = JSON.stringify(revisions);
        const pinnedRegistry = {
          ...registry,
          getSnapshot: () => ({ sourceRevisions: revisions }),
        };
        return {
          fingerprint,
          validateSelection: () => ({ ok: true as const }),
          credentialSource: () => "provider-api-key" as const,
          isCurrent: () => JSON.stringify(sourceRevisions) === fingerprint,
          bindModel: (plan) =>
            bindHostModel({
              plan,
              registry: pinnedRegistry as never,
              adapter: modelAdapter,
            }),
        };
      },
    };
    let host: SessionHost | undefined;
    t.after(async () => {
      try {
        await host?.close();
      } catch {
        /* cleanup after a failed create */
      }
      await harness.shutdown();
      await rm(root, { recursive: true, force: true });
    });

    host = await SessionHost.create({
      root: join(root, "journal"),
      spec: workspaceSpec,
      target,
      catalog,
      registry: registryOfHarnesses,
    });
    assert.deepEqual(created, [{ providerId: "fake-provider", modelId: "fake-model" }]);
    assert.equal(host.plan.catalogFingerprint, JSON.stringify(sourceRevisions));
    assert.equal(host.plan.support.support, "supported");
    assert.match(host.plan.support.reason ?? "", /Fake Model fixture evidence/);
    await host.dispatch({
      type: "send",
      commandId: "factory-text-send",
      hostSessionId: workspaceSpec.hostSessionId,
      turnId: "factory-text-turn",
      text: "Say hello through the fake model.",
    });
    await host.whenIdle();
    assert.ok(
      host
        .eventsSince(0)
        .some(
          (event) =>
            event.kind === "message.finished" &&
            event.role === "assistant" &&
            event.text === "gateway text ok",
        ),
    );
    assert.equal(fake.trace.length, 1);

    sourceRevisions.config = "fake-config-v2";
    const requestsBeforeRebind = fake.trace.length;
    const rebindingSend = await host.dispatch({
      type: "send",
      commandId: "rebind-factory-send",
      hostSessionId: workspaceSpec.hostSessionId,
      turnId: "rebind-factory-turn",
      text: "Continue through the same Codex thread after a catalog update.",
    });
    assert.equal(rebindingSend.status, "accepted");
    await host.whenIdle();
    assert.equal(host.queryCommand("rebind-factory-send")?.status, "completed");
    assert.equal(fake.trace.length, requestsBeforeRebind + 1);
    assert.equal(
      host.queryBindingFact("rebind-factory-send")?.catalogFingerprint,
      JSON.stringify(sourceRevisions),
    );
    assert.equal(
      fake.trace
        .at(-1)
        ?.messages.some(
          (message) =>
            message.role === "user" &&
            JSON.stringify(message.content).includes("Say hello through the fake model."),
        ),
      true,
      "the resumed Codex thread must retain the prior turn without replaying it as a new send",
    );
    assert.equal(
      host
        .eventsSince(0)
        .some((event) => event.kind === "session.error" && event.code === "stale-model-binding"),
      false,
    );
    const stored = host;
    await host.close();
    host = undefined;
    assert.ok((await SessionHost.snapshotHistory(join(root, "journal"), workspaceSpec)).seq > 0);
    host = await SessionHost.open({
      root: join(root, "journal"),
      spec: workspaceSpec,
      target,
      catalog,
      registry: registryOfHarnesses,
    });
    assert.equal(host.plan.catalogFingerprint, JSON.stringify(sourceRevisions));
    await host.close();
    host = undefined;
    assert.equal(fake.trace.length, requestsBeforeRebind + 1);
    assert.ok(
      stored
        .eventsSince(0)
        .some((event) => event.kind === "turn.finished" && event.outcome === "success"),
    );
  },
);
