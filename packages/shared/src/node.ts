/**
 * Node-only shared utilities.
 *
 * This subpath must not be imported by renderer/browser bundles.
 */
export { acquireFileLock } from "./node/atomicFileLock.js";
export { scanOfficialPluginCacheRoots } from "./node/officialPluginCache.js";
export { managedNativeWorkspaceSessionId } from "./node/managedWorkspaceSessionId.js";
export {
  migrateUserSubagentMarkdown,
  migrateSubagentStateFile,
} from "./node/subagentMarkdownMigration.js";
export {
  atomicWritePrivateTextFile,
  backupCorruptFile,
  withFileLock,
  type SharedFileLockOptions,
} from "./node/privateFilePersistence.js";
export {
  withWorkspaceAdmissionFence,
  acquireWorkspaceAdmissionFence,
  WorkspaceAdmissionFenceError,
  workspaceAdmissionFenceFilePath,
  type WorkspaceAdmissionFenceErrorCode,
  type WorkspaceAdmissionFenceRequest,
} from "./node/workspaceAdmissionFence.js";
export {
  createNodeSelfResourceSampler,
  NODE_SELF_RESOURCE_SAMPLE_INTERVAL_MS,
  type NodeSelfResourceSampler,
  type NodeSelfResourceSamplerOptions,
} from "./node/nodeSelfResourceTelemetry.js";
export {
  createHostCapabilityStore,
  createHostCapabilityUpgradeGate,
  DEFAULT_HOST_CAPABILITY_TTL_MS,
  HOST_CAPABILITY_WS_PATH,
  type HostCapabilityStore,
  type HostCapabilityStoreOptions,
  type HostCapabilityUpgradeGate,
  type HostUpgradeAdmission,
  type HostUpgradeRequest,
  type HostUpgradeWebSocketServer,
} from "./node/hostCapabilityStore.js";
