import { createCoreAuthority } from "@zcode/services/node";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";

// Executed only in an isolated child: the parent sets HOME/XDG/profile BEFORE these imports.
const errorInfo = (error: unknown) => ({
  name: error instanceof Error ? error.name : "unknown",
  message:
    error instanceof Error
      ? error.message.replaceAll(process.env.ZCODE_DATA_BASE_DIR ?? "\0", "<profile>")
      : String(error),
});
void (async () => {
  const profile = process.env.ZCODE_SERVER_ROOT!;
  await ensureServerInstallOwnership(resolveServerLayout(profile));
  const authority = await createCoreAuthority({
    installationId: "supervisor-probe",
    profileRoot: profile,
    zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
  });
  try {
    await authority.reconcileBeforeAdmission();
    const result: Record<string, unknown> = {
      type: "probe",
      worker: "public-factory",
      before: null,
      after: null,
    };
    try {
      result.before = await authority.maintenance.readActivity();
    } catch (error) {
      result.beforeError = errorInfo(error);
    }
    let lease: { release(): Promise<void> } | undefined;
    try {
      lease = await authority.maintenance.freezeAdmissions();
      result.frozen = true;
    } catch (error) {
      result.freezeError = errorInfo(error);
    }
    if (lease) {
      try {
        result.after = await authority.maintenance.readActivity();
      } catch (error) {
        result.afterError = errorInfo(error);
      }
      try {
        await lease.release();
        result.released = true;
      } catch (error) {
        result.releaseError = errorInfo(error);
      }
    }
    process.send?.(result);
  } finally {
    await authority.dispose();
  }
  process.disconnect?.();
})().catch((error: unknown) => {
  process.send?.({ type: "probe-error", error: errorInfo(error) }, () => process.exit(1));
});
