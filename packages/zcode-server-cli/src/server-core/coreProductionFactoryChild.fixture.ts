import { runServerCore } from "./core.js";
import { createCoreAuthority } from "@zcode/services/node";
import {
  IAgentHostService,
  IProjectCatalogRpcService,
  IWorkspaceHierarchyService,
} from "@zcode/services";

// Test ONLY duplicates the real public factory; Core itself always uses its default production authority.
process.on("message", (message: unknown) => {
  if (message !== "probe-duplicate") return;
  void createCoreAuthority({
    installationId: "duplicate-owner",
    profileRoot: process.env.ZCODE_SERVER_ROOT!,
    zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
  }).then(
    async (owner) => {
      await owner.dispose();
      process.send?.({ type: "duplicate", rejected: false });
    },
    () => process.send?.({ type: "duplicate", rejected: true }),
  );
});
if (process.argv[2] === "direct") {
  void (async () => {
    const owner = await createCoreAuthority({
      installationId: "direct-profile",
      profileRoot: process.env.ZCODE_SERVER_ROOT!,
      zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
    });
    try {
      await owner.reconcileBeforeAdmission();
      const catalog = owner.services.get(IProjectCatalogRpcService);
      const host = owner.services.get(IAgentHostService);
      const hierarchy = owner.services.get(IWorkspaceHierarchyService);
      let nativeSourceUnavailable = false;
      try {
        await hierarchy.resolveOwner({
          targetId: "direct-profile",
          workspaceId: "missing",
          sessionId: "missing",
        });
      } catch {
        nativeSourceUnavailable = true;
      }
      process.send?.({
        type: "direct",
        revision: await catalog.getRevision(),
        activity: await host.getRuntimeActivity(),
        nativeSourceUnavailable,
      });
    } finally {
      await owner.dispose();
      await owner.dispose(); // idempotent owner cleanup
    }
    const reopened = await createCoreAuthority({
      installationId: "direct-profile",
      profileRoot: process.env.ZCODE_SERVER_ROOT!,
      zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
    });
    await reopened.dispose();
    process.disconnect?.();
    process.exit(0);
  })().catch((error: unknown) => {
    process.stderr.write(String(error));
    process.exit(1);
  });
} else {
  // Default production Core, no override.
  void runServerCore(1).catch((error: unknown) => {
    process.stderr.write(String(error));
    process.exit(1);
  });
}
