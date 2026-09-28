import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import { getCodingPlanCredentialKeys } from "@/settings/model-provider-section/codingPlanEmbeddedWebview.js";

interface CodingPlanEmbeddedWebviewDialogProps {
  credentialService?: {
    load(key: string): Promise<string | null>;
  };
  onOpenChange: (open: boolean) => void;
  open: boolean;
  onOpenResult?: (opened: boolean) => void;
  providerId?: string;
  funnelContext?: unknown;
  audience?: string;
  teamPlanKey?: string | null;
  onPurchaseComplete?: () => void;
}

export function CodingPlanEmbeddedWebviewDialog({
  open,
  onOpenChange,
  onOpenResult,
}: CodingPlanEmbeddedWebviewDialogProps) {
  const { intl } = useZCodeIntl();

  useEffect(() => {
    if (!open) return;
    // 购买 webview 已替换为说明弹窗。打开即视为成功展示，不再等待 dom-ready 注入凭据。
    onOpenResult?.(true);
    if (
      getCodingPlanCredentialKeys("zai").length > 0 ||
      getCodingPlanCredentialKeys("bigmodel").length > 0
    ) {
      logger.error("[CodingPlanEmbeddedWebviewDialog] 拒绝加载产品 OAuth / JWT key");
    }
  }, [onOpenResult, open]);

  if (!open) return null;

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({
              id: "settings.modelProvider.codingPlan.productPurchaseRemovedTitle",
            })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({
              id: "settings.modelProvider.codingPlan.productPurchaseRemoved",
            })}
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
