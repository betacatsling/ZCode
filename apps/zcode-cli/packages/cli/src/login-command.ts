import { formatJson } from "@zcode/core";
import type { GlobalOptions, RunContext } from "@zcode/shared-types";
import type { RunDependencies } from "./cli-types.js";

/** Product account login/logout was removed (REMOVE-PRODUCT-LOGIN P3). */
export const PRODUCT_LOGIN_REMOVED_MESSAGE =
  "Product account login was removed. Configure a personal model provider instead.";

export async function runLoginCommand(
  ctx: RunContext,
  options: GlobalOptions,
  _deps: RunDependencies,
  _noBrowser: boolean,
  _args: readonly string[] = [],
): Promise<number> {
  return writeRemoved(ctx, options);
}

export async function runLogoutCommand(
  ctx: RunContext,
  options: GlobalOptions,
  _deps: RunDependencies,
): Promise<number> {
  return writeRemoved(ctx, options);
}

function writeRemoved(ctx: RunContext, options: GlobalOptions): number {
  if (options.json) {
    ctx.stdout.write(
      formatJson({
        status: "removed",
        code: "product-login-removed",
        message: PRODUCT_LOGIN_REMOVED_MESSAGE,
      }),
    );
  } else {
    ctx.stderr.write(`Error: ${PRODUCT_LOGIN_REMOVED_MESSAGE}\n`);
  }
  return 1;
}
