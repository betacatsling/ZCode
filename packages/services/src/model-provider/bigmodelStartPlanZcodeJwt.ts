interface BigModelStartPlanZcodeJwtCredentialService {
  load(key: string): Promise<string | null>;
}

export async function resolveBigModelStartPlanZcodeJwt(params: {
  credentialService?: BigModelStartPlanZcodeJwtCredentialService;
  provider?: { readonly apiKey?: string | null } | null;
  trustCachedZcodeJwt?: boolean;
}): Promise<string> {
  // 产品 Start Plan JWT（oauth:active_provider / zcodejwttoken）已退役。
  // 只返回调用方已持有的个人 API Key；没有 Key 时返回空串，不读凭据库、不发起授权。
  void params.credentialService;
  void params.trustCachedZcodeJwt;
  return params.provider?.apiKey?.trim() || "";
}
