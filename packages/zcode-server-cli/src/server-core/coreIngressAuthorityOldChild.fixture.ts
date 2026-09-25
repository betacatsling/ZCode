/* Isolated prelaunch refusal: the legacy custom command must never receive a process. */
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createCoreAuthority } from "@zcode/services/node";

let core: Awaited<ReturnType<typeof createCoreAuthority>> | undefined;
try {
  await assert.rejects(async () => {
    core = await createCoreAuthority({
      installationId: "native-mount-fixture",
      profileRoot: process.env.ZCODE_DATA_BASE_DIR!,
      zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
      admissionFence: "held",
    });
  }, /lacks pre-initialization admission fence capability/);
  let spawned = false;
  try {
    await access(process.env.CORE_OLD_CLI_MARKER!);
    spawned = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  assert.equal(spawned, false);
  process.send?.({ type: "old-command-refused", spawned });
} catch (error) {
  process.send?.({ type: "error", reason: String(error) });
  process.exitCode = 1;
} finally {
  await core?.dispose();
  process.disconnect?.();
}
