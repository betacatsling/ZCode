import { useCallback, useMemo } from "react";
import type { ProviderFamilyDomain } from "@zcode/shared";

/**
 * 企业套餐 pricing/获客服务已拆除。保留 hook 签名供设置页/侧栏/composer 拼
 * subscribedTeamProducts；永远空列表，已购 Team 身份改走 entitlement。
 */
export function useEnterpriseCodingPlanProducts({
  enabled,
  authenticated: _authenticated,
  family: _family = "bigmodel",
}: {
  enabled: boolean;
  authenticated: boolean;
  family?: ProviderFamilyDomain;
}) {
  const refresh = useCallback(async (_options?: { force?: boolean }) => {}, []);

  return useMemo(
    () => ({
      snapshot: null,
      loading: false,
      error: enabled ? "service_unavailable" : null,
      refresh,
    }),
    [enabled, refresh],
  );
}
