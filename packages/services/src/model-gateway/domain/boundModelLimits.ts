import { unsupportedFeature } from "./errors.js";

/** 只对照已绑定模型声明的窗口和工具能力，不估算 token，也不压缩上下文。 */
export function rejectResponsesBeyondBoundModel(input: {
  readonly maxOutputTokens?: number;
  readonly contextWindow?: number;
  readonly toolCount: number;
  readonly supportsToolCall?: boolean;
}): void {
  if (input.supportsToolCall === false && input.toolCount > 0) {
    unsupportedFeature("bound model does not support tool calls");
  }
  if (
    input.contextWindow !== undefined &&
    input.maxOutputTokens !== undefined &&
    input.maxOutputTokens > input.contextWindow
  ) {
    unsupportedFeature("max_output_tokens exceeds the bound model context window");
  }
}
