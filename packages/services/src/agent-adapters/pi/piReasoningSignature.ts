import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Model } from "@zcode/contracts";
import type { CapturedHostModel } from "../../agent-host/modelBinding.js";

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

export function appendReasoningMetadata(
  signatures: Map<number, ReasoningMetadata>,
  index: number,
  value?: Record<string, unknown>,
): void {
  if (!value) return;
  const incoming = reasoningMetadata(value);
  if (!incoming) return;
  const previous = signatures.get(index)?.anthropic;
  const next = incoming.anthropic;
  if (!Object.keys(next).length) return;
  if (
    previous &&
    ("redactedData" in previous ||
      "redactedData" in next ||
      ("signature" in previous && !("signature" in next)))
  )
    metadataFailure("anthropic.signatureSequence", next);
  signatures.set(index, {
    anthropic: {
      ...(previous?.signature !== undefined ? { signature: previous.signature } : {}),
      ...(next.signature !== undefined
        ? { signature: (previous?.signature ?? "") + next.signature }
        : {}),
      ...(next.redactedData !== undefined ? { redactedData: next.redactedData } : {}),
    },
  });
}

export function readSignature(
  signature: string,
  message: AssistantMessage,
  model: Model,
  route?: CapturedHostModel["identity"],
): ReasoningMetadata {
  let envelope: unknown;
  try {
    envelope = JSON.parse(signature);
  } catch {
    metadataFailure("thinkingSignature.version", signature);
  }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope))
    metadataFailure("thinkingSignature.version", envelope);
  const record = envelope as Record<string, unknown>;
  for (const [key, value] of Object.entries(record))
    if (
      ![
        "v",
        "kind",
        "providerId",
        "modelId",
        "apiType",
        "endpointFingerprint",
        "providerMetadata",
      ].includes(key)
    )
      metadataFailure(`thinkingSignature.${key}`, value);
  if (record.v !== 1 || record.kind !== SIGNATURE_KIND)
    metadataFailure("thinkingSignature.version", record.v);
  // 修复：Pi 的 API 是合成标识，必须另核对实际冻结的上游 API 类型和端点摘要。
  if (!route) throw new Error("reasoning signature route identity unavailable");
  if (
    message.provider !== HOST_PROVIDER_ID ||
    message.api !== HOST_API ||
    message.model !== `${model.providerId}/${model.modelId}` ||
    record.providerId !== route.providerId ||
    record.modelId !== route.modelId ||
    record.apiType !== route.apiType ||
    record.endpointFingerprint !== route.endpointFingerprint
  )
    throw new Error("reasoning signature route mismatch");
  if (
    !record.providerMetadata ||
    typeof record.providerMetadata !== "object" ||
    Array.isArray(record.providerMetadata)
  )
    metadataFailure("providerMetadata", record.providerMetadata);
  const metadata = reasoningMetadata(record.providerMetadata as Record<string, unknown>);
  if (!metadata || !Object.keys(metadata.anthropic).length)
    metadataFailure("providerMetadata.anthropic", record.providerMetadata);
  return metadata;
}
