import { createAcpProfile, type AcpAgentProfile } from "../acpProfile.js";

/**
 * Devin CLI 的编辑器控制面是官方 `devin acp`（stdio 上的 Agent Client Protocol）。
 * 公开文档把该子进程写成 JSON-RPC，而不是独立协议或交互 REPL，所以只加档案，复用 ACP 状态机。
 * 模型由 Devin 自己的账号决定，属于 harness-managed；这里不追加 `--model`，也不把 prompt 送进 Gateway。
 * 续跑是否可用只由当次 initialize 决定。
 */
export const devinAcpProfile: AcpAgentProfile = createAcpProfile({
  id: "devin",
  name: "Devin",
  executableName: "devin",
  args: ["acp"],
});
