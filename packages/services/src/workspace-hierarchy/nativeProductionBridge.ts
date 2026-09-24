import type { HarnessCapabilitiesV2, ModelBindingRequest } from "@zcode/shared/agent-host";
import type { TargetRuntimeActivity } from "../project-workspaces/worktreeService.js";
import type { NativeSessionDirectory } from "../session/nativeSessionDirectory.js";
import type { WorkspaceNavigationScope, SessionOwner } from "./serviceContract.js";
import type { NativeHierarchyPort } from "./hierarchyService.js";

/** Live V4 owner; no SQLite status or inferred idle value can implement this contract. */
export interface NativeRuntimeFactsPort {
  create(input: { scope: WorkspaceNavigationScope; commandId: string; modelBinding: ModelBindingRequest;
    cwdRelativeToWorktree: string }): Promise<{ originalSessionId: string }>;
  capabilities(owner: Extract<SessionOwner, { kind: "native" }>): Promise<HarnessCapabilitiesV2>;
  activity(workspaceId?: string): Promise<TargetRuntimeActivity>;
  fenceAdmissions(): Promise<() => Promise<void>>;
}

export interface NativeProductionBridge {
  nativeIndex: NativeSessionDirectory;
  native: NativeHierarchyPort;
  nativeActivity(workspaceId?: string): Promise<TargetRuntimeActivity>;
  nativeAdmissionFence(): Promise<() => Promise<void>>;
}

/** Expects independently verified read-only SQLite sources and a real live CLI owner port. */
export function createNativeProductionBridge(options: {
  directory: NativeSessionDirectory;
  runtime: NativeRuntimeFactsPort;
  targetId: string;
}): NativeProductionBridge {
  throw new Error("native-production-bridge-not-implemented");
}
