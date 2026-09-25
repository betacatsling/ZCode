import { isAbsolute } from "node:path";
import type { CapabilityReport, ExecutionTarget } from "@zcode/shared/agent-host";
import type { TrustedAcpProfile } from "./acpHarnessAdapter.js";
import { probeAcpDescriptor } from "./acpTransport.js";
import { isPinnedClaudeAcpDescriptor } from "./pinnedClaudeProfile.js";

const unsupported = (reason: string): CapabilityReport => ({ support: "unsupported", reason });
export async function probeTrustedAcpProfile(
  profile: TrustedAcpProfile,
  target: ExecutionTarget,
): Promise<CapabilityReport> {
  if (!target.available) return unsupported(target.reason ?? "target unavailable");
  try {
    const descriptor = profile.probeDescriptor(target);
    if (
      !isAbsolute(descriptor.cwd) ||
      !isAbsolute(descriptor.executable) ||
      !isAbsolute(descriptor.env.HOME ?? "") ||
      descriptor.version.exact !== profile.version
    )
      return unsupported("ACP trusted probe descriptor path/profile/version mismatch");
    const version = await (profile.transport?.probeVersion ?? probeAcpDescriptor)(descriptor);
    if (version !== profile.version)
      return unsupported(`ACP executable version mismatch (expected ${profile.version})`);
    // 该 pinned 二进制仍读取工作树的 project/local settings 与 PreToolUse hook；
    // 即使装配方错误地标记 certified，也不能宣称工具审批可强制执行。
    return profile.certified && !isPinnedClaudeAcpDescriptor(descriptor)
      ? { support: "supported" }
      : {
          support: "experimental",
          reason:
            "ACP pinned executable found; prompt/tool/approval profile not independently certified",
        };
  } catch {
    return unsupported("ACP executable unavailable or version probe failed on target");
  }
}
