import { isAbsolute } from "node:path";
import { resolveNativeSessionDbPath } from "@zcode/adapters/config";
import { ReadonlyNativeSessionMetadataView } from "@zcode/adapters/storage";
import type { HarnessCapabilitiesV2, ModelBindingRequest } from "@zcode/shared/agent-host";
import { NativePersistentSessionIndex } from "../session/nativePersistentSessionIndex.js";
import {
  NativeSessionDirectory,
  type NativeCreatedMapping,
} from "../session/nativeSessionDirectory.js";
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
  recover?(
    input: Parameters<NativeRuntimeFactsPort["create"]>[0],
  ): Promise<{ originalSessionId: string; creationRemoteSessionId?: string } | undefined>;
  inspect?: NativeHierarchyPort["inspect"];
  completeCertified?: NativeHierarchyPort["completeCertified"];
  create(input: {
    scope: WorkspaceNavigationScope;
    projectId: string;
    repositoryBindingId: string;
    worktreeGeneration: string;
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
  nativeSessionDatabasePath: string | (() => string);
  backupDirectory: string;
  profileId: string;
  listMappings(): Promise<readonly LegacyMapping[]>;
  listNewMappings?(): Promise<readonly NativeCreatedMapping[]>;
}): NativeSessionDirectory {
  if (
    !isAbsolute(options.taskIndexDatabasePath) ||
    !isAbsolute(
      typeof options.nativeSessionDatabasePath === "function"
        ? options.nativeSessionDatabasePath()
        : options.nativeSessionDatabasePath,
    ) ||
    !isAbsolute(options.backupDirectory)
  )
    throw new Error("native-facts-require-configured-absolute-paths");
  const databasePath = () =>
    typeof options.nativeSessionDatabasePath === "function"
      ? options.nativeSessionDatabasePath()
      : options.nativeSessionDatabasePath;
  const targetForScope = async (scope: {
    workspaceKey: string;
    workspacePath: string;
    nativeSessionId: string;
  }) => {
    const mapped = (await options.listMappings()).filter(
      (row) =>
        row.sourceWorkspaceKey === scope.workspaceKey &&
        row.sourceWorkspacePath === scope.workspacePath &&
        row.nativeSessionId === scope.nativeSessionId,
    );
    if (mapped.length > 1) throw new Error("ambiguous-native-owner");
    return mapped[0]?.targetId;
  };
  const metadata = {
    read: (scope: { workspaceKey: string; workspacePath: string; nativeSessionId: string }) =>
      new NativeSqliteMetadataReader(
        new ReadonlyNativeSessionMetadataView(databasePath()),
        targetForScope,
      ).read(scope),
  };
  const index = new NativePersistentSessionIndex(
    options.taskIndexDatabasePath,
    options.backupDirectory,
    options.profileId,
    metadata,
  );
  return new NativeSessionDirectory({
    listMappings: options.listMappings,
    listNewMappings: options.listNewMappings,
    readFacts: () => index.readFacts(),
    // 中文：旧迁移映射仍要校验其原始 DB；但仅含新映射时每条映射已按自身
    // CLI 报告的 source DB 完成收据认证，不应让无关 bootstrap DB 遮蔽有效历史。
    // 两种映射皆无时保留旧的来源校验，不把坏库伪装成正常空目录。
    verifySource: async () => {
      const legacy = await options.listMappings();
      const fresh = await options.listNewMappings?.();
      if (legacy.length > 0 || !fresh?.length)
        await new ReadonlyNativeSessionMetadataView(databasePath()).read("");
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
        ...(scoped.owner.remoteSessionId ? { remoteSessionId: scoped.owner.remoteSessionId } : {}),
        worktreeGeneration: scoped.owner.worktreeGeneration,
        repositoryBindingId: scoped.owner.repositoryBindingId,
      };
    },
    create: (request) => options.runtime.create(request),
    recover: (request) => options.runtime.recover?.(request) ?? Promise.resolve(undefined),
    completeCertified: (commandId, expected) =>
      options.runtime.completeCertified?.(commandId, expected) ??
      Promise.reject(new Error("Native completed-only repair unavailable")),
    inspect: (commandId, expected) =>
      options.runtime.inspect?.(commandId, expected) ??
      Promise.reject(new Error("Native inspection unavailable")),
    capabilities: (owner) => options.runtime.capabilities(owner),
  };
  return {
    nativeIndex: options.directory,
    native,
    nativeActivity: (workspaceId) => options.runtime.activity(workspaceId),
    nativeAdmissionFence: () => options.runtime.fenceAdmissions(),
  };
}
