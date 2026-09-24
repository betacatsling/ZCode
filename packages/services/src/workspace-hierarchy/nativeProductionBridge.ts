import { isAbsolute } from "node:path";
import { resolveNativeSessionDbPath } from "@zcode/adapters/config";
import { ReadonlyNativeSessionMetadataView } from "@zcode/adapters/storage";
import type { HarnessCapabilitiesV2, ModelBindingRequest } from "@zcode/shared/agent-host";
import { NativePersistentSessionIndex } from "../session/nativePersistentSessionIndex.js";
import { NativeSessionDirectory } from "../session/nativeSessionDirectory.js";
import { NativeSqliteMetadataReader } from "../session/nativeSessionMetadata.js";
import type { LegacyMapping } from "../project-workspaces/migrationContract.js";
import type { TargetRuntimeActivity } from "../project-workspaces/worktreeService.js";
import type { WorkspaceNavigationScope, SessionOwner } from "./serviceContract.js";
import type { NativeHierarchyPort } from "./hierarchyService.js";
import type { NativeAdmissionFence } from "./maintenance.js";

/** Live V4 owner; no SQLite status or inferred idle value can implement this contract. */
export interface NativeRuntimeFactsPort {
  /** Explicit live V4 command-ID receipt certification; absent keeps new native create disabled. */
  readonly certifiedCreate?: boolean;
  create(input: {
    scope: WorkspaceNavigationScope;
    commandId: string;
    modelBinding: ModelBindingRequest;
    cwdRelativeToWorktree: string;
  }): Promise<{ originalSessionId: string }>;
  capabilities(owner: Extract<SessionOwner, { kind: "native" }>): Promise<HarnessCapabilitiesV2>;
  activity(workspaceId?: string): Promise<TargetRuntimeActivity>;
  fenceAdmissions(): Promise<NativeAdmissionFence>;
}

export interface NativeProductionBridge {
  nativeIndex: NativeSessionDirectory;
  native: NativeHierarchyPort;
  nativeActivity(workspaceId?: string): Promise<TargetRuntimeActivity>;
  nativeAdmissionFence(): Promise<NativeAdmissionFence>;
}

/**
 * Caller obtains both absolute paths from the configured native bootstrap, not a default location.
 * `listMappings` must be the migration sidecar's verified read (`LegacyWorkspaceMigration.listMappings`).
 * This factory performs no openStartup, migration or write; missing DB and unknown schema fail on read.
 */
export function createReadonlyNativeDirectory(options: {
  taskIndexDatabasePath: string;
  nativeSessionDatabasePath: string;
  backupDirectory: string;
  profileId: string;
  listMappings(): Promise<readonly LegacyMapping[]>;
}): NativeSessionDirectory {
  if (
    !isAbsolute(options.taskIndexDatabasePath) ||
    !isAbsolute(options.nativeSessionDatabasePath) ||
    !isAbsolute(options.backupDirectory)
  )
    throw new Error("native-facts-require-configured-absolute-paths");
  const view = new ReadonlyNativeSessionMetadataView(options.nativeSessionDatabasePath);
  const metadata = new NativeSqliteMetadataReader(view, async (scope) => {
    const mapped = (await options.listMappings()).filter(
      (row) =>
        row.sourceWorkspaceKey === scope.workspaceKey &&
        row.sourceWorkspacePath === scope.workspacePath &&
        row.nativeSessionId === scope.nativeSessionId,
    );
    if (mapped.length > 1) throw new Error("ambiguous-native-owner");
    return mapped[0]?.targetId;
  });
  const index = new NativePersistentSessionIndex(
    options.taskIndexDatabasePath,
    options.backupDirectory,
    options.profileId,
    metadata,
  );
  return new NativeSessionDirectory({
    listMappings: options.listMappings,
    readFacts: () => index.readFacts(),
    // 中文：即使迁移 sidecar 尚无映射，也必须确认 CLI 数据库真实存在且 schema 可读。
    verifySource: async () => {
      await view.read("");
    },
    onChange: (listener) => index.onChange(listener),
    metadata,
  });
}

/** Resolve the identical config/cwd used by native CLI bootstrap; no default-path reconstruction here. */
export function createConfiguredNativeDirectory(
  options: Omit<
    Parameters<typeof createReadonlyNativeDirectory>[0],
    "nativeSessionDatabasePath"
  > & {
    nativeConfig: Parameters<typeof resolveNativeSessionDbPath>[0];
  },
): NativeSessionDirectory {
  const { nativeConfig, ...sources } = options;
  return createReadonlyNativeDirectory({
    ...sources,
    nativeSessionDatabasePath: resolveNativeSessionDbPath(nativeConfig),
  });
}

/** No second V4 executor: the live port is a required, pre-existing CLI-owner attachment. */
export function createNativeProductionBridge(options: {
  directory: NativeSessionDirectory;
  runtime: NativeRuntimeFactsPort;
  targetId: string;
}): NativeProductionBridge {
  if (!options.targetId.trim()) throw new Error("native-target-required");
  const native: NativeHierarchyPort = {
    certifiedCreate: options.runtime.certifiedCreate === true,
    async resolveOwner({ targetId, workspaceId, sessionId }) {
      if (targetId !== options.targetId) return undefined;
      const navigation = await options.directory.resolveOwner({ treeSessionId: sessionId });
      const scoped =
        navigation ??
        (await options.directory.resolveOriginalOwner({
          targetId,
          workspaceId,
          nativeSessionId: sessionId,
        }));
      if (!scoped || scoped.owner.targetId !== targetId || scoped.owner.workspaceId !== workspaceId)
        return undefined;
      return {
        originalSessionId: scoped.owner.nativeSessionId,
        sourceWorkspacePath: scoped.owner.sourceWorkspacePath,
        workspaceIdentity: scoped.owner.sourceWorkspaceKey,
        worktreeGeneration: scoped.owner.worktreeGeneration,
        repositoryBindingId: scoped.owner.repositoryBindingId,
      };
    },
    create: (request) => options.runtime.create(request),
    capabilities: (owner) => options.runtime.capabilities(owner),
  };
  return {
    nativeIndex: options.directory,
    native,
    nativeActivity: (workspaceId) => options.runtime.activity(workspaceId),
    nativeAdmissionFence: () => options.runtime.fenceAdmissions(),
  };
}
