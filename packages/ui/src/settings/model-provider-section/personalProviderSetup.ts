import type { ProviderApiType } from "@zcode/provider";

export interface PersonalProviderSetupDraft {
  name: string;
  baseUrl: string;
  apiType: ProviderApiType;
  apiKey: string;
  modelId: string;
}

export type PersonalProviderSetupIssue =
  | "endpoint-required"
  | "endpoint-invalid"
  | "api-key-required"
  | "model-required";

export function normalizePersonalProviderBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function validatePersonalProviderSetup(
  draft: PersonalProviderSetupDraft,
): PersonalProviderSetupIssue | null {
  const baseUrl = normalizePersonalProviderBaseUrl(draft.baseUrl);
  if (!baseUrl) return "endpoint-required";
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "endpoint-invalid";
  } catch {
    return "endpoint-invalid";
  }
  if (!draft.apiKey.trim()) return "api-key-required";
  if (!draft.modelId.trim()) return "model-required";
  return null;
}

export function resolvePersonalProviderSetupName(draft: PersonalProviderSetupDraft): string {
  const name = draft.name.trim();
  if (name) return name;
  try {
    return new URL(normalizePersonalProviderBaseUrl(draft.baseUrl)).host || "Custom";
  } catch {
    return "Custom";
  }
}

/** 任意 endpoint / 模型的个人 Provider 初始配置，不绑定官方厂商模板。 */
export function buildPersonalProviderInitialConfig(draft: PersonalProviderSetupDraft): {
  access: { type: "api-key"; apiKey: string };
  api: { type: ProviderApiType; baseUrl: string };
} {
  return {
    access: { type: "api-key", apiKey: draft.apiKey.trim() },
    api: {
      type: draft.apiType,
      baseUrl: normalizePersonalProviderBaseUrl(draft.baseUrl),
    },
  };
}
