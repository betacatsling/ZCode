import {
  agentHostSessionMetadataSchema,
  type AgentHostSessionMetadata,
} from "@zcode/shared/agent-host";
import { HarnessRegistry, type HarnessAdapter } from "./harnessRegistry.js";

export type SessionRoute =
  | { kind: "native" }
  | {
      kind: "external";
      hostSessionId: string;
      harness: HarnessAdapter;
      metadata: AgentHostSessionMetadata;
    };

/** Facade decision only. Native V4 is forwarded unchanged; this must not acquire a second owner. */
export class SessionRouter {
  constructor(
    readonly registry: HarnessRegistry,
    readonly policy: { allowExternalAdmission: boolean; enabledHarnesses?: ReadonlySet<string> },
  ) {}

  resolve(
    session: { sessionId: string; agentHost?: AgentHostSessionMetadata },
    targetId: string,
  ): SessionRoute {
    if (!session.agentHost) return { kind: "native" };
    const metadata = agentHostSessionMetadataSchema.parse(session.agentHost);
    if (metadata.hostSessionId !== session.sessionId) throw new Error("session identity mismatch");
    if (metadata.targetId !== targetId) throw new Error("session target identity mismatch");
    if (metadata.harnessId === "zcode")
      throw new Error("native owner cannot be overridden by external metadata");
    return {
      kind: "external",
      metadata,
      hostSessionId: metadata.hostSessionId,
      harness: this.registry.require(metadata.harnessId),
    };
  }

  assertCanCreate(harnessId: string): HarnessAdapter {
    if (harnessId === "zcode") throw new Error("native sessions must use the existing V4 route");
    if (
      !this.policy.allowExternalAdmission ||
      (this.policy.enabledHarnesses && !this.policy.enabledHarnesses.has(harnessId))
    ) {
      throw new Error(`external harness disabled: ${harnessId}`);
    }
    return this.registry.require(harnessId);
  }
}
