// Host capability bootstrap authentication has a single shared implementation in
// @zcode/shared/node, used by both the legacy server and Server Core (see
// docs/agent-host/HOST-CAPABILITY-BOOTSTRAP-AUTH.md). This module only keeps the historical
// import path.
export {
  createHostBootstrapToken,
  HOST_BOOTSTRAP_TOKEN_PATTERN,
  HOST_CAPABILITY_PATH,
  hostBootstrapTokenMatches,
  isLoopbackAuthority,
  presentedHostBootstrapCredential,
  verifyHostBootstrapRequest,
  verifyHostRequestHeaders,
  type HostBootstrapRejectReason,
  type HostBootstrapRequest,
  type HostBootstrapVerdict,
  type HostRequestHeaderOptions,
  type HostRequestHeaderRejection,
  type HostRequestHeaders,
} from "@zcode/shared/node";
