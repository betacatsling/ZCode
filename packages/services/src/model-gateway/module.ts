export const modelGatewayModule = {
  id: "model-gateway",
  requires: ["zcode-cli"],
  provides: ["model-gateway-responses-port"],
  publicEntrypoints: ["contract.ts", "index.ts", "targetModelGateway.ts"],
} as const;
