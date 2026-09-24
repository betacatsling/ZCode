import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Model } from "@zcode/contracts";

export type ReasoningMetadata = { anthropic: { signature?: string; redactedData?: string } };
export const SIGNATURE_KIND = "zcode-reasoning";
export const HOST_PROVIDER_ID = "zcode-host";
export const HOST_API = "zcode-model-executor";

export function metadataFailure(field: string, value: unknown): never {
  const safeField = field.replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 80);
  const type = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  throw new Error(`unsupported reasoning metadata field ${safeField} (type ${type})`);
}

export function reasoningMetadata(value: Record<string, unknown>): ReasoningMetadata | undefined {
  for (const [key, entry] of Object.entries(value))
    if (key !== "anthropic") metadataFailure(key, entry);
  if (!("anthropic" in value)) return undefined;
  const entry = value.anthropic;
  if (!entry || typeof entry !== "object" || Array.isArray(entry))
    metadataFailure("anthropic", entry);
  const anthropic = entry as Record<string, unknown>;
  for (const [key, field] of Object.entries(anthropic)) {
    if (key !== "signature" && key !== "redactedData") metadataFailure(`anthropic.${key}`, field);
    if (typeof field !== "string") metadataFailure(`anthropic.${key}`, field);
  }
  if ("signature" in anthropic && "redactedData" in anthropic)
    metadataFailure("anthropic.signature+redactedData", anthropic);
  return { anthropic: anthropic as ReasoningMetadata["anthropic"] };
}

export function readSignature(signature: string, message: AssistantMessage, model: Model): ReasoningMetadata {
  let envelope: unknown;
  try { envelope = JSON.parse(signature); } catch { metadataFailure("thinkingSignature.version", signature); }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    metadataFailure("thinkingSignature.version", envelope);
  const record = envelope as Record<string, unknown>;
  for (const [key, value] of Object.entries(record))
    if (!["v", "kind", "providerId", "modelId", "providerMetadata"].includes(key))
      metadataFailure(`thinkingSignature.${key}`, value);
  if (record.v !== 1 || record.kind !== SIGNATURE_KIND)
    metadataFailure("thinkingSignature.version", record.v);
  // 修复：签名只对产生它的 Provider、模型和 Pi API 有效；换路由后不得借历史块重放。
  if (message.provider !== HOST_PROVIDER_ID || message.api !== HOST_API ||
      message.model !== `${model.providerId}/${model.modelId}` ||
      record.providerId !== model.providerId || record.modelId !== model.modelId)
    throw new Error("reasoning signature route mismatch");
  if (!record.providerMetadata || typeof record.providerMetadata !== "object" ||
      Array.isArray(record.providerMetadata)) metadataFailure("providerMetadata", record.providerMetadata);
  const metadata = reasoningMetadata(record.providerMetadata as Record<string, unknown>);
  if (!metadata || !Object.keys(metadata.anthropic).length)
    metadataFailure("providerMetadata.anthropic", record.providerMetadata);
  return metadata;
}
