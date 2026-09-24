import { isAbsolute } from "node:path";
import type { CapabilityReport, ExecutionTarget } from "@zcode/shared/agent-host";
import type { TrustedAcpProfile } from "./acpHarnessAdapter.js";
import { probeAcpDescriptor } from "./acpTransport.js";

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
    return profile.certified
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
