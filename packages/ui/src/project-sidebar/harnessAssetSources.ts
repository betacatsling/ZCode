import zcodeDark from "@/assets/cli-icons/icon-glm-for-dark.png";
import zcodeLight from "@/assets/cli-icons/icon-glm-for-light.png";

/** Only checked-in static resources are returned; Host asset IDs never become URLs. */
const STATIC_HARNESS_ASSETS: Readonly<Record<string, string>> = {
  "zcode-light": zcodeLight,
  "zcode-dark": zcodeDark,
};

export function resolveHarnessStaticAsset(assetId: string): string | undefined {
  return STATIC_HARNESS_ASSETS[assetId];
}
