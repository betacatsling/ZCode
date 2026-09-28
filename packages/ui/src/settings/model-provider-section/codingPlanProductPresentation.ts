import type { CodingPlanCardCopyItem, CodingPlanProductPreviewPayment } from "@zcode/shared";

export function normalizeCodingPlanCardCopyItems(items: unknown): CodingPlanCardCopyItem[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.flatMap((item) => {
    if (typeof item !== "string" && (!item || typeof item !== "object")) {
      return [];
    }
    const text =
      typeof item === "string"
        ? item.trim()
        : typeof (item as { text?: unknown }).text === "string"
          ? (item as { text: string }).text.trim()
          : "";
    if (!text) {
      return [];
    }
    const tooltip =
      typeof item === "string" || typeof (item as { tooltip?: unknown }).tooltip !== "string"
        ? ""
        : (item as { tooltip: string }).tooltip.trim();
    return [{ text, ...(tooltip ? { tooltip } : {}) }];
  });
}
export type CodingPlanPriceCurrency = "CNY" | "USD";
export type CodingPlanPriceUnit = "month" | "quarter" | "year";

export type CodingPlanProductDisplay = CodingPlanProductPreviewPayment & {
  priceCurrency?: CodingPlanPriceCurrency;
  externalPurchaseUrl?: string;
  hasPreview?: boolean;
  equity?: CodingPlanCardCopyItem[];
  descriptionItems?: CodingPlanCardCopyItem[];
};

/** 设置页不再渲染可下单的 OAuth 套餐价卡。 */
export const CODING_PLAN_PRODUCT_PURCHASE_CARDS_REMOVED = true;
