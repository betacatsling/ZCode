import { createAcpProfile, type AcpAgentProfile } from "../acpProfile.js";

/** Goose 的 `goose acp` 复用同一 ACP 状态机。续跑能力只来自 initialize，不来自产品名。 */
export const gooseAcpProfile: AcpAgentProfile = createAcpProfile({
  id: "goose",
  name: "Goose",
  executableName: "goose",
  args: ["acp"],
});
