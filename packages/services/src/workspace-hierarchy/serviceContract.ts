import type {
  HarnessCatalogEntry,
  HarnessCapabilitiesV2,
  ModelBindingRequest,
  SessionSpecV2,
} from "@zcode/shared/agent-host";
import type { ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import type { RemovalPreview } from "../project-workspaces/worktreeService.js";
import type { TrustedPngDescriptor } from "../harness-assets/index.js";
import { createServiceDescriptor } from "../descriptors.js";

/** Target-scoped navigation. No path-only or unknown-ID inference is permitted. */
export interface WorkspaceNavigationScope {
  workspaceId: string;
  targetId: string;
  workspaceIdentity: string;
  workspacePath: string;
  remoteSessionId?: string;
}
export type SessionOwner =
  | {
      kind: "native";
      scope: WorkspaceNavigationScope;
      originalSessionId: string;
      historyOnly: boolean;
    }
  | {
      kind: "external";
      scope: WorkspaceNavigationScope;
      spec: SessionSpecV2;
      historyOnly: boolean;
    };

export interface WorkspaceAttachmentMetadata {
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId: string;
  /** Desktop registry generation, NOT Target worktree generation or Core authentication. */
  generation: number;
}

export type CreateCommandInspection =
  | { status: "unknown" | "pending" }
  | {
      status: "unavailable";
      diagnostic: { entryId: string; reason: "uncertified-mapping" | "unreferenced-completion" };
    }
  | { status: "completed"; owner: Extract<SessionOwner, { kind: "native" }> };

export interface IWorkspaceHierarchyService {
  resolveWorkspace(input: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    targetId: string;
  }): Promise<WorkspaceNavigationScope | undefined>;
  resolveOwner(input: {
    targetId: string;
    workspaceId: string;
    sessionId: string;
  }): Promise<SessionOwner | undefined>;
  /** Target-verified live facts; no client-provided execution or Git fields. */
  previewRemoval(input: {
    workspaceId: string;
    expectedGeneration: string;
  }): Promise<RemovalPreview>;
  /** Read-only Target receipt/intent facts; inspection never retries Git or adopts an instance. */
  pendingRecovery(input: { workspaceId: string }): Promise<{
    workspaceId: string;
    status: "unresolved" | "confirmed";
    reason: "target-receipts-unavailable" | "target-result-unknown" | "target-receipt-confirmed";
    generation?: string;
    receiptKind?: "adopt" | "create" | "remove";
    actions: readonly ["inspect"];
  }>;
  listHarnesses(workspaceId: string): Promise<readonly HarnessCatalogEntry[]>;
  /** Certified live Target/Registry options; no client-supplied catalog or path fallback. */
  listCreateOptions(workspaceId: string): Promise<{
    workspaceId: string;
    worktreeGeneration: string;
    options: readonly { harnessId: string; label: string; binding: ModelBindingRequest }[];
  }>;
  createAgent(input: {
    workspaceId: string;
    harnessId: string;
    modelBinding: ModelBindingRequest;
    cwdRelativeToWorktree?: string;
    commandId: string;
    /** Optional view provenance from Desktop's independently authenticated current registry. */
    attachment?: WorkspaceAttachmentMetadata;
  }): Promise<{ owner: SessionOwner; snapshot?: ConversationSnapshot }>;
  /** Pure completed-only inspection; never repairs, allocates, sends or starts CLI. */
  inspectCreateCommand(input: {
    workspaceId: string;
    commandId: string;
    attachment?: WorkspaceAttachmentMetadata;
  }): Promise<CreateCommandInspection>;
  capabilities(owner: SessionOwner): Promise<HarnessCapabilitiesV2>;
  /** Opaque packaged resource only; never accepts client-supplied URL or SVG. */
  asset(assetId: string): Promise<TrustedPngDescriptor | undefined>;
}

export const IWorkspaceHierarchyService =
  createServiceDescriptor<IWorkspaceHierarchyService>("workspace-hierarchy");
