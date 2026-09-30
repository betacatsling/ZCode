import type { ModelGatewayProtocol } from "../contract.js";

/** Environment variable name only. The grant token is never written into the CLI document. */
export const MODEL_GATEWAY_TOKEN_ENV = "ZCODE_MODEL_GATEWAY_TOKEN";

export interface SessionCustomProviderOverlay {
  readonly model: string;
  readonly baseUrl: string;
  readonly envKey: typeof MODEL_GATEWAY_TOKEN_ENV;
  readonly wireApi: "responses";
  readonly configText: string;
}

export function sessionResponsesProviderOverlay(input: {
  readonly baseUrl: string;
  readonly publicModelId: string;
  readonly protocol: ModelGatewayProtocol;
}): SessionCustomProviderOverlay {
  if (input.protocol !== "openai-responses") {
    throw new Error("Anthropic Messages custom provider overlay is not issued by this slice");
  }
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.publicModelId)) {
    throw new Error("public model id is invalid");
  }
  const url = new URL(input.baseUrl);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (
    url.protocol !== "http:" ||
    !loopback ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("custom provider overlay requires a loopback Gateway URL");
  }
  const baseUrl = `${url.origin}/v1`;
  const configText = [
    "# Managed isolated ZCode session provider. No upstream URL or credential is stored here.",
    `model = ${JSON.stringify(input.publicModelId)}`,
    'model_provider = "zcode"',
    "",
    "[model_providers.zcode]",
    'name = "ZCode session-local Model Gateway"',
    `base_url = ${JSON.stringify(baseUrl)}`,
    `env_key = ${JSON.stringify(MODEL_GATEWAY_TOKEN_ENV)}`,
    'wire_api = "responses"',
    "",
  ].join("\n");
  return {
    model: input.publicModelId,
    baseUrl,
    envKey: MODEL_GATEWAY_TOKEN_ENV,
    wireApi: "responses",
    configText,
  };
}
