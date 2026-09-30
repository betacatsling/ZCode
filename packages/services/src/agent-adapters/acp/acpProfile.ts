import type {
  CapabilityReport,
  HarnessPluginManifest,
  HarnessManifest,
} from "@zcode/shared/agent-host";
import { harnessManifestSchema, harnessPluginManifestSchema } from "@zcode/shared/agent-host";
import type { AcpNegotiation } from "./acpProtocol.js";
import { ACP_ADAPTER_VERSION } from "./acpProtocol.js";
import { acpHarnessCapabilities } from "./acpCapabilities.js";

export interface AcpInstallHint {
  readonly executableName: string;
  readonly args: readonly string[];
}

/** 档案只描述产品和安装提示。session/load 不在这里声明。 */
export interface AcpAgentProfile {
  readonly manifest: HarnessPluginManifest;
  readonly directory: HarnessManifest;
  readonly install: AcpInstallHint;
}

export interface AcpCompatibilityReport {
  readonly harnessId: string;
  readonly adapterVersion: string;
  readonly executableName: string;
  readonly install: CapabilityReport;
  readonly stability: AcpNegotiation["stability"] | "unknown";
  readonly stabilityReason?: string;
  readonly authMethodIds: readonly string[];
  readonly resume: CapabilityReport;
  readonly viewHistory: CapabilityReport;
}

export function createAcpProfile(input: {
  id: string;
  name: string;
  executableName: string;
  args: readonly string[];
}): AcpAgentProfile {
  const identity = { id: input.id, name: input.name, adapterVersion: ACP_ADAPTER_VERSION };
  return {
    manifest: harnessPluginManifestSchema.parse(identity),
    directory: harnessManifestSchema.parse({ schemaVersion: 1, ...identity }),
    install: { executableName: input.executableName, args: input.args },
  };
}

/** 不启动进程。找不到可执行文件只说明安装，不推断 session 能力。 */
export function diagnoseAcpInstall(input: {
  profile: AcpAgentProfile;
  executableFound: boolean;
  versionText?: string;
}): CapabilityReport {
  if (!input.executableFound) {
    return {
      support: "unsupported",
      reason: `${input.profile.install.executableName} was not found`,
    };
  }
  return {
    support: "supported",
    constraints: {
      executableName: input.profile.install.executableName,
      args: [...input.profile.install.args],
      ...(input.versionText ? { versionText: input.versionText } : {}),
    },
  };
}

export function buildAcpCompatibilityReport(input: {
  profile: AcpAgentProfile;
  install: CapabilityReport;
  negotiation?: AcpNegotiation;
}): AcpCompatibilityReport {
  const capabilities = acpHarnessCapabilities(input.negotiation);
  return {
    harnessId: input.profile.manifest.id,
    adapterVersion: input.profile.manifest.adapterVersion,
    executableName: input.profile.install.executableName,
    install: input.install,
    stability: input.negotiation?.stability ?? "unknown",
    ...(input.negotiation?.stabilityReason
      ? { stabilityReason: input.negotiation.stabilityReason }
      : {}),
    authMethodIds: input.negotiation?.authMethods.map((method) => method.methodId) ?? [],
    resume: capabilities.resumeExecution,
    viewHistory: capabilities.viewHistory ?? {
      support: "supported",
      constraints: { source: "host-events", continuesExecution: false },
    },
  };
}
