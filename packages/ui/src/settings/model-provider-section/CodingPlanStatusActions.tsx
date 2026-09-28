import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

export function CodingPlanProductPurchaseRemovedNotice() {
  const { intl } = useZCodeIntl();
  return (
    <p className="max-w-sm text-ui-sm leading-5 text-foreground-subtle">
      {intl.formatMessage({
        id: "settings.modelProvider.codingPlan.productPurchaseRemoved",
      })}
    </p>
  );
}

export function CodingPlanStatusActions({
  isDisconnected,
  isUnavailable,
  isPurchased,
  loginVisible,
  canDisconnectProvider,
  disconnectLoading,
  onDisconnect,
}: {
  providerName: string;
  isDisconnected: boolean;
  isUnavailable: boolean;
  isPurchased: boolean;
  loginLoading?: boolean;
  loginButtonId: string;
  loginVisible: boolean;
  canDisconnectProvider: boolean;
  disconnectLoading?: boolean;
  onDisconnect?: () => void;
}) {
  const { intl } = useZCodeIntl();

  return (
    <div className="flex shrink-0 flex-wrap justify-start gap-2">
      {loginVisible && (isDisconnected || isUnavailable) ? (
        <CodingPlanProductPurchaseRemovedNotice />
      ) : null}
      {canDisconnectProvider && onDisconnect && !isPurchased ? (
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={disconnectLoading}
          onClick={onDisconnect}
        >
          {disconnectLoading ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({
            id: "settings.modelProvider.codingPlan.disconnect",
          })}
        </Button>
      ) : null}
    </div>
  );
}

