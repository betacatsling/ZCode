import type { SidebarSnapshot } from "@zcode/shared/project-workspaces";
import type { HarnessCatalogEntry, ModelBindingRequest } from "@zcode/shared/agent-host";

export interface DiscoveryCandidate {
  path: string;
  label: string;
  head: string;
}
export interface CreateWorkspaceInput {
  repositoryBindingId: string;
  title: string;
  baseRef: string;
  branch: string;
  worktreePath: string;
}
export interface CreateAgentInput {
  workspaceId: string;
  expectedGeneration: string;
  harnessId: string;
  modelBinding: ModelBindingRequest;
  draft: string;
}
export interface SidebarActions {
  onSelectSession: (sessionId: string) => void;
  onOpenAttention: (sessionId: string) => void;
  onCreateAgent: (input: CreateAgentInput) => Promise<void>;
  onDiscover: (repositoryBindingId: string) => Promise<void>;
  onAdopt: (repositoryBindingId: string, path: string) => Promise<void>;
  onCreateWorkspace: (input: CreateWorkspaceInput) => Promise<void>;
  onHideWorkspace: (workspaceId: string) => Promise<void>;
  onArchiveWorkspace: (workspaceId: string) => Promise<void>;
  onRemoveWorkspace: (workspaceId: string, expectedGeneration: string) => Promise<void>;
}
export interface ProjectSidebarProps {
  snapshot: SidebarSnapshot;
  catalog: readonly HarnessCatalogEntry[];
  actions: SidebarActions;
  /** Labels are supplied by the target registry, not inferred from paths. */
  targetLabels: Readonly<Record<string, string>>;
  /** Model labels are presentation hints; not an authoritative persisted binding. */
  modelLabels?: Readonly<Record<string, string>>;
  /** Trusted asset resolver returns a safe image URL or undefined, never raw HTML. */
  resolveIconAsset: (assetId: string) => string | undefined;
  discovery?: Readonly<Record<string, readonly DiscoveryCandidate[]>>;
  locale: "en" | "zh";
  modelOptions?: readonly { harnessId: string; label: string; binding: ModelBindingRequest }[];
}
