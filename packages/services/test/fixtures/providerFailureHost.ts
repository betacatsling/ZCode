/**
 * Real Pi target for provider-failure tests: loopback fake Provider (per-key failure status with
 * a key-looking string in the upstream error body), real Registry, real AiSdkModelAdapter and
 * real Pi harness, wired through the shared registryPiHost fixture.
 */
import { once } from "node:events";
import { createServer } from "node:http";
import { AiSdkModelAdapter } from "@zcode/adapters/model";
import type { SessionSpec } from "@zcode/shared/agent-host";
import {
  addPersonalProvider,
  createPiTargetService,
  hostManagedPiSpec,
  localTarget,
  startRegistryRuntime,
  type AdapterRetry,
} from "./registryPiHost.js";

/** Appears in the Provider API key and in the upstream error body; must never reach a client. */
export const LEAK_MARKER = "sk-leak";

/** Fake OpenAI-compatible Provider: `failWith` (401/403/...) or a one-chunk streamed answer. */
export async function startFailingProvider() {
  const state: { failWith?: number; requests: number } = { requests: 0 };
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      state.requests += 1;
      if (state.failWith !== undefined) {
        response.writeHead(state.failWith, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: `Incorrect API key provided: ${LEAK_MARKER}-upstream-echo`,
              type: "invalid_request_error",
            },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    state,
    close: async () => {
      server.close();
      await once(server, "close");
    },
  };
}

export async function createProviderFailureHost(
  root: string,
  origin: string,
  retry?: AdapterRetry,
) {
  const { runtime, worktree } = await startRegistryRuntime(root);
  const providerId = await addPersonalProvider(runtime, {
    providerName: "Failing Provider",
    baseUrl: `${origin}/v1`,
    apiKey: `${LEAK_MARKER}-configured-key`,
    modelId: "failing-model",
  });
  await runtime.registryService.refresh("provider-failure-fixture");
  const adapter = new AiSdkModelAdapter({
    streamIdleTimeoutMs: 5_000,
    ...(retry ? { retry } : {}),
  });
  const targetId = "remote-typed-failure";
  const target = createPiTargetService({ root, runtime, adapter, target: localTarget(targetId) });
  const specFor = (hostSessionId: string): SessionSpec =>
    hostManagedPiSpec({
      hostSessionId,
      targetId,
      workspaceIdentity: "typed-failure-workspace",
      worktreePath: worktree,
      selection: { providerId, modelId: "failing-model" },
    });
  return {
    target,
    providerId,
    specFor,
    dispose: async () => {
      await target.close().catch(() => undefined);
      runtime.dispose();
    },
  };
}
