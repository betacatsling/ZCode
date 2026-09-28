import type { BareRepositoryAdoptionRequest, WorktreeCatalogFile } from "./contract.js";
import type { WorkspaceRemovalPreview } from "./removalContract.js";

export const worktreeContractExample: WorktreeCatalogFile = {
  schemaVersion: 1,
  bindings: [],
  workspaces: [],
  creationReceipts: [],
};

/** Discovery evidence from a bare repository with zero linked worktrees. */
export const bareRepositoryAdoptionRequestExample: BareRepositoryAdoptionRequest = {
  targetId: "target-local",
  inputPath: "/tmp/example.git",
  repositoryCommonDir: "/tmp/example.git",
  commonDirEvidence: {
    canonicalPath: "/tmp/example.git",
    device: 1,
    inode: 42,
    birthtimeMs: 1_800_000_000_000,
  },
};

export const linkedWorktreeRemovalPreviewExample: WorkspaceRemovalPreview = {
  workspaceId: "workspace-linked",
  targetId: "target-local",
  expectedGeneration: "generation-current",
  safeToRemove: true,
  blockers: [],
  risks: { dirty: false, untracked: false, submodule: false, locked: false },
  externalProcessBoundary: "unmanaged-writers-not-enumerated",
  confirmationToken: "single-use-preview-token",
};
