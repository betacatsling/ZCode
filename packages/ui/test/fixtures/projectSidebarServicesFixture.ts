// This fixture imports the real pure projection entry directly because the
// services root barrel also exports Node-only adapters used by desktop hosts.
export { projectSidebarSnapshot } from "../../../services/src/agent-ui-projection/sidebarProjector.js";
export { createConversationTelemetryService } from "../../../services/src/conversation-telemetry/conversationTelemetry.js";
export { ZCODE_AGENT_RUNTIME_UNAVAILABLE_CODE } from "../../../services/src/zcode-agent/zcodeAgent.js";
export { isCuaPermissionStatusAvailable } from "../../../zcode-cua/broker-ports.js";
