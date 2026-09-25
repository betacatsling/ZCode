import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const SELECTED_MODEL = {
  providerId: "fixture",
  modelId: "fixture-model",
  options: { reasoningLevel: "off" },
};
export const CHILD_MODEL = {
  providerId: "fixture",
  modelId: "fixture-other",
  options: { reasoningLevel: "off" },
};

export async function writeProviderConfig(root: string, baseUrl: string): Promise<void> {
  const settingsRoot = join(root, ".zcode", "v2");
  await mkdir(settingsRoot, { recursive: true });
  const modelConfig = {
    enabled: true,
    properties: {
      contextWindow: 65536,
      requiresMfjsToolSchema: false,
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
  };
  await writeFile(
    join(settingsRoot, "provider_config.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerConfigRules: {
          providerRules: [
            {
              providerId: "fixture",
              providerName: "Fixture",
              enabled: true,
              config: {
                group: "standard-personal",
                access: { type: "api-key", apiKey: "fixture-only-not-a-credential" },
                api: { type: "anthropic-messages", baseUrl },
                personalModelIds: ["fixture-model", "fixture-other"],
              },
            },
          ],
        },
        modelConfigRules: {
          providerModelRules: [
            { providerId: "fixture", modelId: "fixture-model", config: modelConfig },
            { providerId: "fixture", modelId: "fixture-other", config: modelConfig },
          ],
          manualProviderModelRules: [],
        },
        defaultModelSelection: SELECTED_MODEL,
      },
    }),
  );
}
