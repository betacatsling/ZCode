import { CodexHarnessAdapter } from "./codexHarnessAdapter.js";
export { codexTrustedManifest, type CodexTurnLeaseIssuer } from "./codexAdapterContract.js";
export { createCodexGatewayLeaseIssuer } from "./createCodexGatewayLeaseIssuer.js";
export { CodexHarnessAdapter } from "./codexHarnessAdapter.js";
/** Trusted target-local V2 factory; no native-account fallback. */
export function createCodexHarness(
  options: ConstructorParameters<typeof CodexHarnessAdapter>[0],
): CodexHarnessAdapter {
  return new CodexHarnessAdapter(options);
}
