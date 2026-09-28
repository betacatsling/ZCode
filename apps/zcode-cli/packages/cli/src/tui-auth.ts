import { loadBootstrapModule } from "./bootstrap-loader.js";
import type { RunDependencies } from "./cli-types.js";
import type {
  CommandCenterApiKeyOptions,
  CommandCenterBigmodelLoginOptions,
  CommandCenterLoginOptions,
} from "./command-center/types.js";
import { PRODUCT_LOGIN_REMOVED_MESSAGE } from "./login-command.js";

export async function loginForTui(
  _deps: RunDependencies,
  _options?: CommandCenterLoginOptions,
): Promise<never> {
  throw new Error(PRODUCT_LOGIN_REMOVED_MESSAGE);
}

export async function loginBigmodelForTui(
  _deps: RunDependencies,
  _options?: CommandCenterBigmodelLoginOptions,
): Promise<never> {
  throw new Error(PRODUCT_LOGIN_REMOVED_MESSAGE);
}

export async function configureApiKeyForTui(
  deps: RunDependencies,
  options: CommandCenterApiKeyOptions,
) {
  const configure =
    deps.configureCodingPlanApiKey ?? (await loadBootstrapModule()).configureCodingPlanApiKey;
  return await configure({
    apiKey: options.apiKey,
    env: deps.env ?? process.env,
    providerId: options.providerId,
  });
}

export async function logoutForTui(_deps: RunDependencies): Promise<never> {
  throw new Error(PRODUCT_LOGIN_REMOVED_MESSAGE);
}
