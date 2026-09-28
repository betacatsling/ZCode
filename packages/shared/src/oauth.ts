/**
 * OAuth / provider 领域类型（薄清后）。
 *
 * 产品登录 start/callback/session/JWT 广播等类型已卸（deeplink #40、平台契约 #47、
 * Root restore #71）。本文件仅保留：
 * - Coding Plan / model-provider-family 仍用的 provider id 与 OAuthProviderId
 * - 通用凭据解密错误码（services credential cipher）
 * - 仍被 telemetry / UI 引用的归因与 UserInfo（后续刀再卸）
 *
 * MCP / 第三方 OAuth 机器凭据在 `mcp.ts` + CLI adapters，不依赖本文件。
 * 敏感信息（appSecret）与 provider 默认端点只允许放在 services provider 模块。
 */

/** 内置 BigModel provider id */
export const BIGMODEL_PROVIDER_ID = "bigmodel" as const;

/** 内置 ZAI provider id */
export const ZAI_PROVIDER_ID = "zai" as const;

/** 凭据解密失败错误前缀 */
export const CREDENTIAL_DECRYPT_ERROR_PREFIX = "凭据解密失败：" as const;

/** 凭据解密失败稳定错误码 */
export const CREDENTIAL_DECRYPT_ERROR_CODE = "ZCODE_CREDENTIAL_DECRYPT_FAILED" as const;

/** OAuth provider 标识 */
export type OAuthProviderId =
  | typeof BIGMODEL_PROVIDER_ID
  | typeof ZAI_PROVIDER_ID
  | (string & { readonly __oauthProviderBrand?: never });

/** OAuth 登录归因参数：来自官网中转页或投放链接（telemetry 仍引用） */
export interface OAuthLoginAttribution {
  channel_id?: string;
  utm_source?: string;
  utm_campaign?: string;
}

export interface UserInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
}
