import { ModelErrorCode, ModelProtocolError } from "@zcode/contracts";
import type { ModelExecutionRequest } from "./model.js";
import type { ResolvedAiSdkModel } from "./runner-runtime.js";

/** Keep Responses instructions and developer-role history in separate Provider fields. */
export function instructionProviderOptions(
  request: Pick<ModelExecutionRequest, "messages" | "systemInstructions">,
  resolved: Pick<ResolvedAiSdkModel, "providerKind" | "providerOptions">,
 ) {
  const hasDeveloperMessages = request.messages.some((message) => message.role === "developer");
  const hasSystemInstructions = request.systemInstructions !== undefined;
  if (!hasDeveloperMessages && !hasSystemInstructions) return undefined;
  if (
    resolved.providerKind !== "openai" ||
    resolved.providerOptions?.apiFormat !== "openai-responses"
  ) {
    throw new ModelProtocolError(
      ModelErrorCode.InvalidModelRequest,
      "System/developer instruction layers require the OpenAI Responses provider",
    );
  }
  return {
    openai: {
      ...(hasSystemInstructions ? { instructions: request.systemInstructions } : {}),
      ...(hasDeveloperMessages ? { systemMessageMode: "developer" as const } : {}),
    },
  };
}
