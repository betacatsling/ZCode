import type { HarnessManifest } from "@zcode/shared/agent-host";
import type { TrustedClaudeProfile } from "./contract.js";
import { ClaudeHarnessAdapter } from "./claudeHarnessAdapter.js";
export type { TrustedClaudeProfile, ClaudeGatewayLease } from "./contract.js";

export const claudeCodeManifest: HarnessManifest = Object.freeze({
  schemaVersion: 1,
  id: "claude-code",
  name: "Claude Code",
  adapterVersion: "2.1.263",
});
/** Target-local registration; do not register a second native ZCode executor. */
export function createClaudeHarness(profile: TrustedClaudeProfile): ClaudeHarnessAdapter {
  return new ClaudeHarnessAdapter(profile);
}
