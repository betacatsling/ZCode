import type { HarnessManifest } from "@zcode/shared/agent-host";
import type { HarnessAdapter } from "../../agent-host/harnessRegistry.js";
import type { TrustedClaudeProfile } from "./contract.js";
export type { TrustedClaudeProfile, ClaudeGatewayLease } from "./contract.js";

export const claudeCodeManifest: HarnessManifest = Object.freeze({ schemaVersion: 1, id: "claude-code", name: "Claude Code", adapterVersion: "2.1.263" });
/** Target-local registration; do not register a second native ZCode executor. */
export function createClaudeHarness(_profile: TrustedClaudeProfile): HarnessAdapter {
  throw new Error("Claude adapter mechanics not yet mounted");
}
