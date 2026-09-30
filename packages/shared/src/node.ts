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
  createHostBootstrapToken,
  HOST_BOOTSTRAP_TOKEN_PATTERN,
  HOST_CAPABILITY_PATH,
  hostBootstrapTokenMatches,
  isLoopbackAuthority,
  isSameOriginAsHost,
  presentedHostBootstrapCredential,
  verifyHostBootstrapRequest,
  verifyHostRequestHeaders,
  verifyLocalEndpointHeaders,
  type HostBootstrapRejectReason,
  type HostBootstrapRequest,
  type HostBootstrapVerdict,
  type HostRequestHeaderOptions,
  type HostRequestHeaderRejection,
  type HostRequestHeaders,
  type LocalEndpointHeaderPolicy,
  type LocalEndpointHeaderRejection,
  type LocalEndpointOriginPolicy,
} from "./node/hostBootstrapAuth.js";
export {
  createHostCapabilityStore,
  createHostCapabilityUpgradeGate,
  DEFAULT_HOST_CAPABILITY_TTL_MS,
  HOST_CAPABILITY_WS_PATH,
  hostBootstrapCredentialFingerprint,
  isHostCapabilityBindingAccepted,
  type HostCapabilityBinding,
  type HostCapabilityBindingPolicy,
  type HostCapabilityStore,
  type HostCapabilityStoreOptions,
  type HostCapabilityUpgradeGate,
  type HostCapabilityUpgradeGateOptions,
  type HostUpgradeAdmission,
  type HostUpgradeRequest,
  type HostUpgradeWebSocketServer,
} from "./node/hostCapabilityStore.js";
