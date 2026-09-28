export { countRunningTasks, type ExternalActivityFact } from "./runtime/activityCount.js";
export {
  assertResidentLifetime,
  planAttachmentClose,
  type AttachmentClosePlan,
  type AttachmentCloseReason,
} from "./runtime/attachment.js";
export {
  createTargetOwnerGate,
  ownerFencePath,
  reserveOwnerLease,
  type OwnerLease,
} from "./runtime/ownerFence.js";
