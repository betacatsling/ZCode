import { getZCodeCopy } from "@zcode/i18n";
import type { CommandCenterApp } from "./command-center.js";
import { PRODUCT_LOGIN_REMOVED_MESSAGE } from "./login-command.js";

export function loginRequiredResponse(locale?: string): string {
  const copy = getZCodeCopy(locale).tui.loginRequired;
  // Gate means "no selectable models", not product account login.
  return [PRODUCT_LOGIN_REMOVED_MESSAGE, copy.message, copy.help].join("\n");
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
