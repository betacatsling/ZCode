/*
 * ZCode 官方 Server MCP 的身份头形状。
 *
 * 产品账号登录拆除后，官方 Server MCP 不再解析 Coding Plan / 产品 JWT。
 * 调用方得到明确的 official_auth_plan_required，而不是匿名放行或继续打账号接口。
 * 第三方 MCP 自己的 OAuth 不经过这里。
 */
import { OFFICIAL_MCP_AUTH_HEADER_NAMES, type OfficialMcpAuthFailureReason } from "@zcode/shared";

export type OfficialMcpPlanScope =
  | { targetType: "PERSONAL" }
  | { targetType: "TEAM"; organizationId: string; projectId: string };

export type OfficialMcpWireScope = OfficialMcpPlanScope | null;

/** 解析成功后的凭证快照。仅在 host/service 进程内存活，脱敏后才允许过 RPC。 */
export interface OfficialMcpCredentialSnapshot {
  jwt: string;
  /**
   * MaaS 登录 JWT（不带 Bearer 前缀）。
   * 前缀在 buildOfficialMcpAuthHeaders 里加。
   */
  codingPlanAuthorization?: string;
  providerFamily: "zai" | "bigmodel";
  planScope: OfficialMcpPlanScope | null;
  wireScope: OfficialMcpWireScope;
}

export type OfficialMcpCredentialOutcome =
  | { ok: true; snapshot: OfficialMcpCredentialSnapshot }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

export function buildOfficialMcpAuthHeaders(
  snapshot: OfficialMcpCredentialSnapshot,
): Record<string, string> {
  const headers: Record<string, string> = {
    [OFFICIAL_MCP_AUTH_HEADER_NAMES.authorization]: `Bearer ${snapshot.jwt}`,
  };
  if (snapshot.codingPlanAuthorization) {
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.codingPlanAuthorization] =
      `Bearer ${snapshot.codingPlanAuthorization}`;
  }
  const scope = snapshot.wireScope;
  if (scope) {
    headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.targetType] = scope.targetType;
    if (scope.targetType === "TEAM") {
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.organization] = scope.organizationId;
      headers[OFFICIAL_MCP_AUTH_HEADER_NAMES.project] = scope.projectId;
    }
  }
  return headers;
}

/** host handler 透传的请求上下文；不参与凭证选择。 */
interface OfficialMcpAuthHeadersRequestContext {
  mcpKey: string;
  pluginId: string;
  targetOrigin: string;
  workspace: { workspaceIdentity?: string; workspaceKey: string; workspacePath: string };
}

type OfficialMcpAuthHeadersOutcome =
  | { ok: true; headers: Record<string, string> }
  | { ok: false; reason: OfficialMcpAuthFailureReason };

/**
 * 产品账号凭证已拆除。解析立即失败，不读取 oauth 凭据，也不访问套餐接口。
 */
export async function resolveOfficialMcpCredentials(): Promise<OfficialMcpCredentialOutcome> {
  return { ok: false, reason: "official_auth_plan_required" };
}

export function createOfficialMcpAuthHeadersResolver(): {
  resolveHeaders(
    request?: OfficialMcpAuthHeadersRequestContext,
  ): Promise<OfficialMcpAuthHeadersOutcome>;
} {
  return {
    resolveHeaders() {
      return resolveOfficialMcpCredentials().then((outcome) =>
        outcome.ok
          ? { ok: true as const, headers: buildOfficialMcpAuthHeaders(outcome.snapshot) }
          : { ok: false as const, reason: outcome.reason },
      );
    },
  };
}
