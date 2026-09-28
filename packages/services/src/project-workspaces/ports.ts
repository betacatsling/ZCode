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

/** 迁移写入前的目录副本。实现方负责落到调用方指定的位置，本模块不删除用户文件。 */
export interface MigrationBackupWriter {
  write(backup: {
    schemaVersion: 1;
    fingerprint: string;
    catalog: import("./snapshot.js").CatalogSnapshot;
  }): Promise<void>;
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
