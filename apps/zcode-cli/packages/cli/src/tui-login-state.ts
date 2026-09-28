import { getZCodeCopy } from "@zcode/i18n";
import type { CommandCenterApp } from "./command-center.js";
import { PRODUCT_LOGIN_REMOVED_MESSAGE } from "./login-command.js";

export function loginRequiredResponse(locale?: string): string {
  const copy = getZCodeCopy(locale).tui.loginRequired;
  // Prefer explicit removal copy; fall back to i18n help without pushing /login OAuth.
  return [
    PRODUCT_LOGIN_REMOVED_MESSAGE,
    copy.help.replace(/\/login/g, "provider settings"),
  ].join("\n");
}

/** Registry already applies provider/account availability, including personal providers. */
export function createTuiModelAvailabilityChecker(
  getApp: () => Promise<CommandCenterApp>,
): () => Promise<boolean> {
  return async () => {
    const app = await getApp();
    return ((await app.listModels?.()) ?? []).some((model) => !model.disabledReason);
  };
}
