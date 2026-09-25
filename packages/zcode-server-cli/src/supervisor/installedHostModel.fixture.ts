import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Disposable fake model; no provider credentials, global listener, or real model calls. */
export async function createInstalledHostModel(dir: string): Promise<{
  requestSeen: Promise<void>;
  requestCount(): number;
  sendWriteCallOnNextRequest(): void;
  close(): Promise<void>;
}> {
  let received!: () => void;
  const requestSeen = new Promise<void>((resolve) => {
    received = resolve;
  });
  let nextWriteCall = false;
  let requests = 0;
  const frame = (type: string, fields: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
  const server = createServer((request, response) => {
    // The accepted Host turn must actually reach its model, not a fabricated running counter.
    if (request.method !== "POST" || request.url !== "/v1/responses") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
    requests += 1;
    received();
    if (nextWriteCall) {
      nextWriteCall = false;
      const item = {
        id: "fc_write",
        type: "function_call",
        name: "write",
        call_id: "fixture-write",
        arguments: JSON.stringify({ path: "unapproved.txt", content: "must-not-be-written" }),
        status: "completed",
      };
      response.write(
        frame("response.created", {
          response: { id: "fixture-response", model: "fixture-model", created_at: 1760000000 },
        }),
      );
      response.write(frame("response.output_item.added", { output_index: 0, item }));
      response.write(
        frame("response.function_call_arguments.delta", {
          item_id: item.id,
          output_index: 0,
          delta: item.arguments,
        }),
      );
      response.write(
        frame("response.function_call_arguments.done", {
          item_id: item.id,
          output_index: 0,
          arguments: item.arguments,
        }),
      );
      response.write(frame("response.output_item.done", { output_index: 0, item }));
      response.end(
        frame("response.completed", {
          response: {
            id: "fixture-response",
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        }) + "data: [DONE]\n\n",
      );
      return;
    }
    // Hold a real upstream request while Supervisor obtains the post-freeze census.
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing local fake-model port");
    const configDir = join(dir, ".zcode", "v2");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, "provider_config.json"),
      JSON.stringify({
        schemaVersion: 1,
        config: {
          providerConfigRules: {
            providerRules: [
              {
                providerId: "fixture-local",
                providerName: "Disposable loopback",
                enabled: true,
                config: {
                  group: "standard-personal",
                  access: { type: "api-key", apiKey: "fixture-only-not-a-credential" },
                  api: { type: "openai-responses", baseUrl: `http://127.0.0.1:${address.port}/v1` },
                  personalModelIds: ["fixture-model"],
                  modelOrder: ["fixture-model"],
                },
              },
            ],
          },
          modelConfigRules: {
            providerModelRules: [
              {
                providerId: "fixture-local",
                modelId: "fixture-model",
                config: {
                  enabled: true,
                  properties: {
                    requiresMfjsToolSchema: false,
                    contextWindow: 8192,
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
                    maxOutputTokens: { max: 2048, map: '{"max_output_tokens": maxOutputTokens}' },
                  },
                },
              },
            ],
            manualProviderModelRules: [],
          },
        },
      }),
    );
    return {
      requestSeen,
      requestCount: () => requests,
      sendWriteCallOnNextRequest() {
        nextWriteCall = true;
      },
      async close() {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      },
    };
  } catch (error) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw error;
  }
}
