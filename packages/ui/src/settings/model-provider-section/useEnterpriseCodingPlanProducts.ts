import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  EnterpriseCodingPlanPricingResponse,
  ProviderFamilyDomain,
} from "@zcode/shared";
import { isRemoteWorkspaceDisconnectedError } from "@/lib/remoteWorkspaceServiceError.js";
import { logger } from "@/logger.js";
import {
  resolveEnterpriseCodingPlanProductList,
  type EnterpriseCodingPlanProductDisplay,
} from "@/settings/model-provider-section/enterpriseCodingPlanProducts.js";
import { normalizeErrorMessage } from "@/settings/model-provider-section/codingPlanErrorMessage.js";

interface EnterpriseCodingPlanProductsState {
  snapshot: EnterpriseCodingPlanProductsSnapshot | null;
  loading: boolean;
  error: string | null;
}

interface EnterpriseCodingPlanProductsSnapshot {
  productList: EnterpriseCodingPlanProductDisplay[];
  raw: EnterpriseCodingPlanPricingResponse;
  authenticated: boolean;
}

function shouldRetainEnterprisePricingSnapshotForRefresh(
  snapshot: EnterpriseCodingPlanProductsSnapshot | null,
  authenticated: boolean,
): boolean {
  return snapshot?.authenticated === authenticated;
}

type EnterpriseCodingPlanReader = {
  getEnterprisePricing(request: {
    authenticated: boolean;
    family: ProviderFamilyDomain;
  }): Promise<EnterpriseCodingPlanPricingResponse>;
};

/** 产品订阅服务已拆除。函数返回类型避免 const undefined 把后续分支收成 never。 */
function removedEnterpriseCodingPlanService(): EnterpriseCodingPlanReader | undefined {
  return undefined;
}

/**
 * 给企业套餐展示列表打上 family 标记（zai / bigmodel）。
 */
function tagEnterpriseProductsFamily(
  products: EnterpriseCodingPlanProductDisplay[],
  family: ProviderFamilyDomain,
): EnterpriseCodingPlanProductDisplay[] {
  return products.map((product) => ({ ...product, family }));
}

export function useEnterpriseCodingPlanProducts({
  enabled,
  authenticated,
  family = "bigmodel",
}: {
  enabled: boolean;
  authenticated: boolean;
  family?: ProviderFamilyDomain;
}) {
  const service = removedEnterpriseCodingPlanService();
  const [state, setState] = useState<EnterpriseCodingPlanProductsState>({
    snapshot: null,
    loading: enabled,
    error: null,
  });

  const refresh = useCallback(
    async (_options?: { force?: boolean }) => {
      if (!enabled) {
        setState((current) => ({
          snapshot: current.snapshot,
          loading: false,
          error: null,
        }));
        return;
      }
      if (!service) {
        setState({
          snapshot: null,
          loading: false,
          error: "service_unavailable",
        });
        return;
      }

      setState((current) => ({
        snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
          ? current.snapshot
          : null,
        loading: true,
        error: null,
      }));

      try {
        const raw = await service.getEnterprisePricing({ authenticated, family });
        setState({
          snapshot: {
            raw,
            productList: tagEnterpriseProductsFamily(
              resolveEnterpriseCodingPlanProductList(raw.productList),
              family,
            ),
            authenticated,
          },
          loading: false,
          error: null,
        });
      } catch (error) {
        const message = normalizeErrorMessage(error);
        if (!isRemoteWorkspaceDisconnectedError(error)) {
          logger.warn("[useEnterpriseCodingPlanProducts] 读取企业 Coding Plan 套餐失败", {
            authenticated,
            error: message,
          });
        }
        setState((current) => ({
          snapshot: shouldRetainEnterprisePricingSnapshotForRefresh(current.snapshot, authenticated)
            ? current.snapshot
            : null,
          loading: false,
          error: message,
        }));
      }
    },
    [authenticated, enabled, family, service],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return useMemo(
    () => ({
      ...state,
      refresh,
    }),
    [refresh, state],
  );
}
