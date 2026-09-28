import type { ConfirmDialogRequest } from "@/store/confirmDialogStore.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import { getProviderFormLabel } from "@/lib/providerSettingsFormTypes.js";
import type { IntlInstance } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
export async function confirmAndDeleteModelProvider({
  provider,
  confirmDialog,
  intl,
  deleteProvider,
}: {
  provider: ProviderSettingsFormProvider;
  confirmDialog: (payload: ConfirmDialogRequest) => Promise<boolean>;
  intl: IntlInstance;
  deleteProvider: (providerId: string) => Promise<void>;
}) {
  if (provider.config.group === "zai-family" || provider.config.group === "bigmodel-family") {
    return;
  }

  logger.info("[ModelProviderSection] 请求删除自定义模型供应商", {
    providerId: provider.providerId,
    providerName: getProviderFormLabel(provider),
  });

  const confirmed = await confirmDialog({
    title: intl.formatMessage(
      { id: "settings.modelProvider.deleteConfirmTitle" },
      { name: getProviderFormLabel(provider) },
    ),
    description: intl.formatMessage({
      id: "settings.modelProvider.deleteConfirmDescription",
    }),
    confirmLabel: intl.formatMessage({
      id: "settings.modelProvider.deleteConfirmAction",
    }),
    cancelLabel: intl.formatMessage({ id: "common.cancel" }),
  });
  if (!confirmed) {
    logger.info("[ModelProviderSection] 用户取消删除自定义模型供应商", {
      providerId: provider.providerId,
      providerName: getProviderFormLabel(provider),
    });
    return;
  }

  try {
    await deleteProvider(provider.providerId);
  } catch (error) {
    logger.error("[ModelProviderSection] 删除模型供应商失败", error);
  }
}

export async function refreshModelProviderSection({
  refresh,
}: {
  refresh: () => Promise<void>;
}) {
  // Model Provider 顶部刷新：企业 Team 产品列表已拆除，只刷 provider 列表。
  // entitlement / quota 由调用方另行触发。
  await refresh();
}

export async function refreshProviderPanelAfterAuthChange({
  refreshModelProviders,
  refreshCodingPlanEntitlements,
  refreshCodingPlanProducts,
  refreshPurchaseTokenState,
  refreshPlanSnapshots = true,
}: {
  refreshModelProviders: () => Promise<void>;
  refreshCodingPlanEntitlements: () => Promise<void>;
  refreshCodingPlanProducts: () => void;
  refreshPurchaseTokenState: () => Promise<unknown>;
  refreshPlanSnapshots?: boolean;
}): Promise<void> {
  await refreshPurchaseTokenState();
  if (refreshPlanSnapshots) {
    await Promise.all([
      refreshModelProviders(),
      refreshCodingPlanEntitlements(),
    ]);
  } else {
    // 切换连接方式只是保存本地连接选择和刷新目标 provider key。
    // 不能顺手刷新今日余额/套餐快照，否则 Start Plan balance 与 entitlement 查询会并发放大。
    await refreshModelProviders();
  }
  refreshCodingPlanProducts();
}
