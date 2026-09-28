import { CodingPlanEmbeddedWebviewDialog } from "@/settings/CodingPlanEmbeddedWebviewDialog.js";
import type { CodingPlanUpgradeDialogTarget } from "@/settings/codingPlanUpgradeLoginRecovery.js";

export { isCodingPlanPurchaseAuthPending } from "@/settings/model-provider-section/codingPlanPurchaseAuth.js";
export {
  beginCodingPlanUpgradeLogin,
  resolvePendingCodingPlanUpgradeAfterLogin,
} from "@/settings/codingPlanUpgradeLoginRecovery.js";
export type { CodingPlanUpgradeDialogTarget } from "@/settings/codingPlanUpgradeLoginRecovery.js";

interface CodingPlanUpgradeDialogProps {
  target?: CodingPlanUpgradeDialogTarget;
  onClose: () => void;
  onOpenResult?: (opened: boolean) => void;
  onReopen?: (target: CodingPlanUpgradeDialogTarget) => void;
}

export function CodingPlanUpgradeDialog({
  target,
  onClose,
  onOpenResult,
}: CodingPlanUpgradeDialogProps) {
  if (!target) {
    return null;
  }

  return (
    <CodingPlanEmbeddedWebviewDialog
      open
      onOpenResult={onOpenResult}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    />
  );
}
