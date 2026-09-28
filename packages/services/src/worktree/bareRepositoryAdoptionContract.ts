import type { RepositoryBinding } from "@zcode/shared/agent-host";

export interface BareRepositoryAdoptionRequest {
  targetId: string;
  inputPath: string;
  repositoryCommonDir: string;
  commonDirEvidence: {
    canonicalPath: string;
    device: number | null;
    inode: number | null;
    birthtimeMs: number | null;
  };
}

/** Repository takeover is separate from workspace adoption because bare repos may have none. */
export interface IWorktreeBareRepositoryAdoptionService {
  adoptBareRepository(
    projectId: string,
    request: BareRepositoryAdoptionRequest,
  ): Promise<RepositoryBinding>;
}
