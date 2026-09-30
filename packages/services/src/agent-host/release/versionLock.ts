import { MODEL_GATEWAY_VERSION } from "../../model-gateway/contract.js";
import {
  ACP_ADAPTER_VERSION,
  ACP_OFFERED_PROTOCOL_VERSION,
  ACP_STABLE_PROTOCOL_VERSION,
} from "../../agent-adapters/acp/acpProtocol.js";
import { PINNED_CLAUDE_CLI_VERSION } from "../../agent-adapters/claude/claudeExecutable.js";
import { CLAUDE_CODE_ADAPTER_VERSION } from "../../agent-adapters/claude-code/claudeCodeVersion.js";
import { PINNED_CODEX_CLI_VERSION } from "../../agent-adapters/codex/codexExecutable.js";
import { ZCODE_ADAPTER_VERSION } from "../../agent-adapters/zcode/zcodeHarnessAdapter.js";

/** 验收只描述 macOS 本机。其他平台的现有注册代码不在这里分支。 */
export const RELEASE_ACCEPTANCE = {
  os: "darwin",
  supervisor: "launchd",
  scope: "local-mac",
} as const;

/**
 * 合成所依赖的已发布契约。数值来自现有常量或已有字面量，不新增 schema 字段。
 * Codex / Pi adapter 的 version 字段没有单独导出，由测试对照源码锁定。
 */
export const RELEASE_CONTRACT_LOCK = {
  modelGateway: MODEL_GATEWAY_VERSION,
  codexCliProbe: PINNED_CODEX_CLI_VERSION,
  codexAdapter: "0.157.1",
  piSdk: "0.87.1",
  piAdapter: "0.87.1",
  claudeCodeAdapter: CLAUDE_CODE_ADAPTER_VERSION,
  claudeCli: PINNED_CLAUDE_CLI_VERSION,
  acpAdapter: ACP_ADAPTER_VERSION,
  acpStableProtocol: ACP_STABLE_PROTOCOL_VERSION,
  acpOfferedProtocol: ACP_OFFERED_PROTOCOL_VERSION,
  zcodeAdapter: ZCODE_ADAPTER_VERSION,
  sessionSpecVersions: [1, 2] as const,
  sessionMetadataSchemaVersion: 1 as const,
  sessionHierarchySchemaVersion: 1 as const,
  projectSchemaVersion: 1 as const,
  v4WireProtocol: 3 as const,
  zcodeProtocol: 1 as const,
} as const;
