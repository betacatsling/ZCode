import type {
  AgentHostSessionSummary,
  HarnessDirectorySnapshot,
  HierarchySnapshot,
  SidebarSnapshot,
  SidebarWorkspaceNode,
  SessionHierarchyFile,
  StaticHarnessAsset,
  WorkspaceSessionCreateRequest,
} from "@zcode/shared/agent-host";
import type {
  AgentHostConversationOwnerLocator,
  AgentHostConversationAttachment,
  AgentHostConversationSelection,
} from "@/v4/agentHostConversationOwner.js";
import type {
  ProjectCatalogFile,
  ProjectCatalogReadModel,
  ProjectCatalogTargetPresentation,
} from "@zcode/services/project-catalog";
import type { WorktreeCandidate, WorktreeCatalogFile } from "@zcode/services/worktree";
import type { RemoteTarget } from "@zcode/shared";
import type { IAgentHostService, IModelSelectionService } from "@zcode/services";

export interface ProjectSidebarNativeSessionMetadata {
  readonly title: string;
  readonly updatedAt: number;
}

export interface ProjectSidebarCandidate extends WorktreeCandidate {
  readonly existingProject?: { readonly projectId: string; readonly name: string };
  readonly bindingProjectMissing?: boolean;
}

export interface ProjectSidebarBareRepositoryCandidate {
  readonly kind: "bare-repository";
  readonly targetId: string;
  readonly inputPath: string;
  readonly repositoryCommonDir: string;
  readonly commonDirEvidence: WorktreeCandidate["commonDirEvidence"];
  readonly existingProject?: { readonly projectId: string; readonly name: string };
  readonly bindingProjectMissing?: boolean;
}

export type ProjectSidebarImportSelection =
  | { readonly kind: "worktree"; readonly candidate: ProjectSidebarCandidate }
  | { readonly kind: "bare-repository"; readonly candidate: ProjectSidebarBareRepositoryCandidate };

export type ProjectSidebarImportResult =
  | { readonly status: "choices"; readonly candidates: readonly ProjectSidebarCandidate[] }
  | {
      readonly status: "bare-repository";
      readonly candidate: ProjectSidebarBareRepositoryCandidate;
    }
  | { readonly status: "complete" };

export interface ProjectSidebarTargetOption {
  readonly targetId: string;
  readonly attachmentGeneration: number;
  readonly remoteSessionId: string | null;
  readonly isLocal: boolean;
  readonly writable: boolean;
  readonly targetPresentation: ProjectCatalogTargetPresentation;
}

export interface ProjectSidebarTargetServices {
  readonly agentHostService: IAgentHostService | null;
  readonly modelSelectionService: IModelSelectionService | null;
}

export type ProjectSidebarHarnessAssetLoader = (
  targetId: string,
  attachmentGeneration: number,
  assetId: string,
) => Promise<StaticHarnessAsset | null>;

export type ProjectSidebarAgentCreateHandler = (
  target: ProjectSidebarTargetOption,
  workspace: SidebarWorkspaceNode,
  worktreeGeneration: string,
  request: Pick<
    WorkspaceSessionCreateRequest,
    "requestId" | "harnessId" | "modelBinding" | "title"
  >,
) => Promise<void>;

export interface ProjectSidebarWorkspaceBindingOption extends ProjectSidebarTargetOption {
  readonly repositoryBindingId: string;
  readonly repositoryPath: string;
}

/**
 * UI-only route projection. Both owner facts remain owned by SessionHierarchy
 * and AgentHost summaries; this value is never persisted as another registry.
 */
export type ProjectSidebarAgentHostOwnerLocator = AgentHostConversationOwnerLocator;

/** Attachment fields are added only at the explicit sidebar selection edge. */
export type ProjectSidebarAgentHostAttachment = AgentHostConversationAttachment & {
  readonly remoteTarget?: RemoteTarget;
};

/** App-shell-only selection fence; it does not enter AgentHost business state. */
export type ProjectSidebarAgentHostSelection = AgentHostConversationSelection;

export interface ProjectSidebarTargetViewSnapshot {
  readonly targetId: string;
  readonly attachmentGeneration: number;
  readonly remoteSessionId: string | null;
  readonly remoteTarget?: RemoteTarget;
  readonly isLocal: boolean;
  readonly targetPresentation: ProjectCatalogTargetPresentation;
  readonly targetWritable: boolean;
  readonly summaryFailures: ReadonlyMap<string, "stale" | "offline">;
  readonly model: ProjectSidebarTargetViewModel;
}

export interface ProjectSidebarTargetSourceSnapshot {
  readonly catalog: ProjectCatalogFile;
  readonly worktrees: WorktreeCatalogFile;
  readonly hierarchy: HierarchySnapshot;
  readonly migration: SessionHierarchyFile | null;
  readonly directory: HarnessDirectorySnapshot;
  readonly summaries: readonly AgentHostSessionSummary[];
  readonly targetFreshness: ReadonlyMap<string, "live" | "stale" | "offline" | "unknown">;
  readonly nativeSessionMetadata: ReadonlyMap<string, ProjectSidebarNativeSessionMetadata>;
  readonly targetWritable: boolean;
}

export interface ProjectSidebarSourceSnapshot {
  readonly catalog: ProjectCatalogReadModel;
  readonly targets: readonly ProjectSidebarTargetViewSnapshot[];
  readonly targetFreshness: ReadonlyMap<string, "live" | "stale" | "offline" | "unknown">;
}

export type ProjectSidebarSessionAction =
  | {
      readonly ownerKind: "native-v4";
      readonly targetId: string;
      readonly isLocal: boolean;
      readonly attachmentGeneration: number;
      readonly remoteSessionId: string | null;
      readonly remoteTarget?: RemoteTarget;
      readonly nativeSessionId: string;
      readonly workspacePath: string | null;
      readonly workspaceIdentity?: string;
      readonly selectable: boolean;
      readonly reason?: string;
    }
  | {
      readonly ownerKind: "agent-host";
      readonly targetId: string;
      readonly isLocal: boolean;
      readonly attachmentGeneration: number;
      readonly remoteSessionId: string | null;
      readonly remoteTarget?: RemoteTarget;
      readonly ownerLocator?: ProjectSidebarAgentHostOwnerLocator;
      readonly workspacePath: string | null;
      readonly workspaceIdentity?: string;
      readonly selectable: boolean;
      readonly reason?: string;
    };

export interface ProjectSidebarViewModel {
  readonly source: ProjectSidebarSourceSnapshot;
  readonly snapshot: SidebarSnapshot;
  readonly sessionActions: ReadonlyMap<string, ProjectSidebarSessionAction>;
  readonly staleReason?: string;
}

export interface ProjectSidebarTargetViewModel {
  readonly source: ProjectSidebarTargetSourceSnapshot;
  readonly snapshot: SidebarSnapshot;
  readonly sessionActions: ReadonlyMap<string, ProjectSidebarSessionAction>;
}

export type ProjectSidebarLoadState =
  | { status: "loading" }
  | { status: "ready" | "refreshing"; model: ProjectSidebarViewModel }
  | { status: "unavailable"; reason: string };
