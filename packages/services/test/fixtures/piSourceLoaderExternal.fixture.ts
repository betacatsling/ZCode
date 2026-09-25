import assert from "node:assert/strict";
import { join } from "node:path";
import type { Model } from "@zcode/contracts";
import { HarnessRegistry } from "../../src/agent-host/harnessRegistry.js";
import { SessionHost } from "../../src/agent-host/sessionHost.js";
import { PiHarnessAdapter } from "../../src/agent-adapters/pi/piHarnessAdapter.js";

// The parent launches this fixture from an external, dependency-free cwd.
// Its absolute parent preload does not supply the worker with a resolvable bare preload.
const workspace = process.cwd();
const adapter = new PiHarnessAdapter({
  root: join(workspace, "private-worker"),
  modelFactory: () => ({
    model: {
      providerId: "fixture-provider",
      modelId: "fixture-model",
      displayName: "Fixture",
      options: { reasoningLevel: "off" },
      properties: { contextWindow: 32000 },
      optionSpecs: { maxOutputTokens: { max: 1000 } },
      async *streamText() {
        yield { type: "start", modelId: "fixture-model" };
        yield { type: "text_start", id: "answer" };
        yield { type: "text_delta", id: "answer", text: "external worker ready" };
        yield { type: "text_end", id: "answer" };
        yield { type: "finish", finishReason: "stop", usage: { inputTokens: 1, outputTokens: 2 } };
      },
    } as unknown as Model,
    identity: {
      providerId: "fixture-provider",
      modelId: "fixture-model",
      apiType: "anthropic-messages",
      endpointFingerprint: "f".repeat(64),
    },
  }),
});
const registry = new HarnessRegistry();
registry.register(adapter);
try {
  const host = await SessionHost.create({
    root: join(workspace, "journals"),
    spec: {
      schemaVersion: 2,
      projectId: "fixture-project",
      workspaceId: "external-workspace",
      hostSessionId: "pi-external-cwd",
      execution: {
        targetId: "local",
        workspaceIdentity: "external-workspace",
        worktreePath: workspace,
        worktreeGeneration: "fixture-generation",
        cwdRelativeToWorktree: ".",
      },
      harness: { id: "pi", adapterVersion: "0.87.1" },
      modelBinding: {
        kind: "host-managed",
        selection: {
          providerId: "fixture-provider",
          modelId: "fixture-model",
          options: { reasoningLevel: "off" },
        },
      },
    },
    target: {
      id: "local",
      kind: "local",
      platform: process.platform as "darwin" | "linux",
      available: true,
    },
    registry,
    catalog: { fingerprint: "fixture", validateSelection: () => ({ ok: true }) },
  });
  const result = await host.dispatch({
    type: "send",
    commandId: "external-1",
    hostSessionId: "pi-external-cwd",
    turnId: "turn-1",
    text: "reply",
  });
  assert.equal(result.status, "accepted");
  await host.whenIdle();
  assert.equal(host.queryCommand("external-1")?.status, "completed");
  assert.equal(
    host
      .snapshot()
      .rows.window.some(
        (row) => row.kind === "assistantText" && row.text === "external worker ready",
      ),
    true,
  );
  console.log("EXTERNAL_PI_SOURCE_READY_ACCEPTED_COMPLETED");
} finally {
  await adapter.shutdown();
}
