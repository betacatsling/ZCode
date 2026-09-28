import { createAcpProfile, type AcpAgentProfile } from "../acpProfile.js";

/** OpenCode 通过 `opencode acp` 提供 ACP 传输。续跑是否可用只由当次 initialize 决定。 */
export const openCodeAcpProfile: AcpAgentProfile = createAcpProfile({
  id: "opencode",
  name: "OpenCode",
  executableName: "opencode",
  args: ["acp"],
});
