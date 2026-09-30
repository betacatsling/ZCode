import type { ProviderConfigSnapshot } from "@zcode/provider";

/**
 * Whether the ZCode Built-in provider config layer is in use, i.e. whether the anonymous
 * background check `GET <zcode endpoint>/api/v1/client/configs` (startup + 60 s interval) has
 * anything to keep up to date.
 *
 * In use = at least one enabled personal Provider is bound to a ZCode Built-in template
 * (`templateId` present in the Built-in `templateRules`). Such a Provider takes its access, API
 * endpoint and built-in model ids from the Built-in layer at resolve time, so remote template
 * updates matter to it.
 *
 * Not counted:
 *  - Built-in account Providers (`account:*` in the Built-in `providerRules`): product login was
 *    removed and the account overlay source is empty, so they can never become executable;
 *  - custom personal Providers without a template, and disabled ones.
 * A fresh install, or one that only has custom Providers, therefore never contacts the ZCode
 * control plane for this check. An explicit refresh (Settings "refresh sources") is unaffected.
 */
export function isZCodeBuiltinInUse(config: ProviderConfigSnapshot): boolean {
  return config.personalProviders
    .rules()
    .some(
      (rule) =>
        rule.enabled !== false &&
        typeof rule.templateId === "string" &&
        config.zcodeBuiltinProviderTemplates.get(rule.templateId) !== undefined,
    );
}
