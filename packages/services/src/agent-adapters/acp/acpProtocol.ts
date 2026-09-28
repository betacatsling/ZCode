/** 稳定合同只有 ACP v1。v2 改变了 session/load 和 prompt 完成语义。 */
export const ACP_STABLE_PROTOCOL_VERSION = 1;
export const ACP_OFFERED_PROTOCOL_VERSION = 2;
export const ACP_ADAPTER_VERSION = "0.1.0";
export const ACP_SESSION_MACHINE_ID = "acp-session-machine/1";

export interface AcpAuthMethod {
  readonly methodId: string;
  readonly type?: string;
}

export interface AcpNegotiation {
  readonly protocolVersion: number;
  readonly stability: "stable" | "experimental";
  readonly stabilityReason?: string;
  readonly agentName?: string;
  readonly agentVersion?: string;
  readonly authMethods: readonly AcpAuthMethod[];
  readonly loadSession: boolean;
  readonly resumeSession: boolean;
  readonly resumeReplaysHistory: boolean;
  readonly imagesAdvertised: boolean;
}

export function acpInitializeParams(): Record<string, unknown> {
  const info = { name: "zcode", version: ACP_ADAPTER_VERSION };
  return {
    protocolVersion: ACP_OFFERED_PROTOCOL_VERSION,
    info,
    capabilities: {},
    clientInfo: info,
    clientCapabilities: {},
  };
}

/**
 * 只读取本次 initialize 结果。品牌、缺省值和未知版本里的 loadSession 都不能变成续跑能力。
 * v2 及未知版本回到 experimental，并且不继承 v1 的 session/load。
 */
export function negotiateAcpInitialize(result: unknown): AcpNegotiation {
  if (!isRecord(result) || typeof result.protocolVersion !== "number") {
    throw new Error("ACP initialize response is missing protocolVersion");
  }
  const version = result.protocolVersion;
  const info = isRecord(result.agentInfo) ? result.agentInfo : isRecord(result.info) ? result.info : undefined;
  const base = {
    protocolVersion: version,
    authMethods: readAuthMethods(result.authMethods),
    ...(typeof info?.name === "string" ? { agentName: info.name } : {}),
    ...(typeof info?.version === "string" ? { agentVersion: info.version } : {}),
  };
  if (version === ACP_STABLE_PROTOCOL_VERSION) {
    const capabilities = isRecord(result.agentCapabilities) ? result.agentCapabilities : {};
    const prompt = isRecord(capabilities.promptCapabilities) ? capabilities.promptCapabilities : {};
    const session = isRecord(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
    const loadSession = capabilities.loadSession === true;
    const resumeSession = session.resume !== undefined && session.resume !== null && session.resume !== false;
    return {
      ...base,
      stability: "stable",
      loadSession,
      resumeSession,
      resumeReplaysHistory: loadSession,
      imagesAdvertised: prompt.image === true,
    };
  }
  if (version === 2) {
    const capabilities = isRecord(result.capabilities) ? result.capabilities : {};
    const session = isRecord(capabilities.session) ? capabilities.session : undefined;
    const prompt = session && isRecord(session.prompt) ? session.prompt : undefined;
    return {
      ...base,
      stability: "experimental",
      stabilityReason: "ACP protocol version 2 changes session resume and prompt completion semantics",
      loadSession: false,
      resumeSession: session !== undefined,
      resumeReplaysHistory: false,
      imagesAdvertised: prompt?.image !== undefined && prompt.image !== null,
    };
  }
  return {
    ...base,
    stability: "experimental",
    stabilityReason: `ACP protocol version ${version} is not a stable contract`,
    loadSession: false,
    resumeSession: false,
    resumeReplaysHistory: false,
    imagesAdvertised: false,
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readAuthMethods(value: unknown): AcpAuthMethod[] {
  if (!Array.isArray(value)) return [];
  const methods: AcpAuthMethod[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const methodId = typeof entry.methodId === "string" ? entry.methodId : typeof entry.id === "string" ? entry.id : "";
    if (!methodId.trim()) continue;
    const method: AcpAuthMethod = { methodId: methodId.trim() };
    methods.push(typeof entry.type === "string" ? { ...method, type: entry.type } : method);
  }
  return methods;
}
