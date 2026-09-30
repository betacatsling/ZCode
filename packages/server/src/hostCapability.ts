// The Host capability ticket store and its consume-on-upgrade gate have a single shared
// implementation in @zcode/shared/node, used by both the legacy server and Server Core.
// This module only keeps the historical import path.
export {
  createHostCapabilityStore,
  createHostCapabilityUpgradeGate,
  DEFAULT_HOST_CAPABILITY_TTL_MS,
  HOST_CAPABILITY_WS_PATH,
  type HostCapabilityStore,
  type HostCapabilityStoreOptions,
  type HostCapabilityUpgradeGate,
} from "@zcode/shared/node";
