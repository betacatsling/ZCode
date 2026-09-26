// ============================================================
// Vercel AI SDK runner request helpers
// ============================================================

import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import type { ModelOptions, ModelRequestAuth } from "@zcode/contracts";
import type { AiSdkResolvedModel } from "./model-execution.js";
import type {
  AiSdkModelTextRequest,
  ResolvedAiSdkModel,
} from "./runner-runtime.js";
import { normalizeReasoningHistory } from "./reasoning-history-normalization.js";

export function requireMaxOutputTokens(options: ModelOptions): number {
  if (options.maxOutputTokens === undefined) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      "maxOutputTokens requires an explicit request value",
    );
  }
  return options.maxOutputTokens;
}

export function hasRequestAuth(
  requestAuth: ModelRequestAuth | undefined,
): requestAuth is ModelRequestAuth {
  if (requestAuth?.apiKey?.trim()) return true;
  return Object.values(requestAuth?.headers ?? {}).some((value) => value.trim().length > 0);
}

export function assertSameBoundModel(
  bound: ResolvedAiSdkModel,
  refreshed: AiSdkResolvedModel,
): AiSdkResolvedModel {
  if (bound.providerId !== refreshed.providerId || bound.modelId !== refreshed.modelId) {
    throw new Error("Runtime header refresh changed the bound model identity.");
  }
  return refreshed;
}

export function projectRequestHistory(
  request: AiSdkModelTextRequest,
  resolved: ResolvedAiSdkModel,
): AiSdkModelTextRequest {
  if (resolved.providerKind !== "anthropic") return request;

  // 结构归一化过去位于每次物理请求都会经过的 serializer，签名修复重试
  // 因而会再次删除上一轮刚补出的 assistant 占位并合并 user。逻辑请求入口只投影一次，
  // 后续 attempt 只能复用或从这份 request-local history 派生。
  const messages = normalizeReasoningHistory(request.messages, {
    providerId: resolved.providerId,
    modelId: resolved.modelId,
  });
  return messages === request.messages ? request : { ...request, messages };
}
