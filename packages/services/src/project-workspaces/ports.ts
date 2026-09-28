export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProjectWorkspaceGitPort {
  run(args: readonly string[]): Promise<GitExecResult>;
}

export interface FilesystemIdentity {
  device: number | null;
  inode: number | null;
}

export interface ProjectWorkspaceFilesystemPort {
  realpath(path: string): Promise<string>;
  identity(path: string): Promise<FilesystemIdentity>;
  exists(path: string): Promise<boolean>;
  access(path: string): Promise<"ok" | "denied" | "missing">;
}

export interface WorkspaceActivityPort {
  inspect(workspaceId: string): Promise<"idle" | "busy" | "approval" | "unknown">;
  stopSessions(sessionIds: readonly string[]): Promise<void>;
}

export interface CatalogStore {
  read(): Promise<import("./snapshot.js").CatalogSnapshot>;
  update<T>(
    mutator: (
      current: import("./snapshot.js").CatalogSnapshot,
    ) => { snapshot: import("./snapshot.js").CatalogSnapshot; result: T },
  ): Promise<T>;
}

export interface ProjectWorkspaceDeps {
  executionTargetId: string;
  git: ProjectWorkspaceGitPort;
  filesystem: ProjectWorkspaceFilesystemPort;
  activity: WorkspaceActivityPort;
  store: CatalogStore;
  idFactory: () => string;
  knownHarnessIds?: readonly string[];
}
