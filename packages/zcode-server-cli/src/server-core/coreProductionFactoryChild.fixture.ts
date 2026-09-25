import { runServerCore } from "./core.js";
import { createCoreAuthority } from "@zcode/services/node";
import { ensureServerInstallOwnership } from "../runtime/installationOwnership.js";
import { resolveServerLayout } from "../runtime/paths.js";
import {
  IAgentHostService,
  IProjectCatalogRpcService,
  IWorkspaceHierarchyService,
  IZCodeAgentService,
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
      const nativeBeforeFence = (await owner.maintenance.readActivity()).native;
      const frozen = await owner.maintenance.freezeAdmissions();
      await owner.services
        .get(IZCodeAgentService)
        .disposeWorkspace({ workspacePath: process.cwd() });
      const afterWorkerExit = (await owner.maintenance.readActivity()).native;
      let staleReleaseRejected = false;
      try {
        await frozen.release();
      } catch {
        staleReleaseRejected = true;
      }
      process.send?.({
        type: "direct",
        afterWorkerExit,
        staleReleaseRejected,
        revision: await catalog.getRevision(),
        sidebar: await catalog.sidebarSnapshot(),
        activity: await host.getRuntimeActivity(),
        nativeBeforeFence,
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
    // Real construction reaches the CLI owner, then fails during storage startup. Its
    // ServiceCollection and profile writer must both be released before a same-profile retry.
    const previousCommand = process.env.ZCODE_AGENT_SERVER_COMMAND;
    process.env.ZCODE_AGENT_SERVER_COMMAND = "/nonexistent/core-factory-cli";
    let partialBootRejected = false;
    try {
      const unexpected = await createCoreAuthority({
        installationId: "direct-profile",
        profileRoot: process.env.ZCODE_SERVER_ROOT!,
        zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
      });
      await unexpected.dispose();
    } catch {
      partialBootRejected = true;
    }
    if (previousCommand === undefined) delete process.env.ZCODE_AGENT_SERVER_COMMAND;
    else process.env.ZCODE_AGENT_SERVER_COMMAND = previousCommand;
    const afterPartialBoot = await createCoreAuthority({
      installationId: "direct-profile",
      profileRoot: process.env.ZCODE_SERVER_ROOT!,
      zcodeBuiltinProviderConfigFilePath: process.env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE!,
    });
    await afterPartialBoot.dispose();
    process.send?.({ type: "partial-boot", rejected: partialBootRejected });
    process.disconnect?.();
    process.exit(0);
  })().catch((error: unknown) => {
    process.stderr.write(String(error));
    process.exit(1);
  });
} else {
  // Test-only real installer setup; never synthesize an ownership marker or authority.
  void (async () => {
    if (process.env.ZCODE_FIXTURE_INSTALL_ROOT) {
      await ensureServerInstallOwnership(
        resolveServerLayout(process.env.ZCODE_FIXTURE_INSTALL_ROOT),
      );
    }
    await runServerCore(1);
  })().catch((error: unknown) => {
    process.stderr.write(String(error));
    process.exit(1);
  });
}
