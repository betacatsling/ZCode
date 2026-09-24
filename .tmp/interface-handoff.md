# core-boot early public seam

Owner: `packages/zcode-server-cli/src/server-core/` + Supervisor binding. Typed integration needed from `@zcode/services/node` (service-boot owns implementation):

```ts
interface CoreAuthorityComposition {
  services: ServiceCollection;
  maintenance: {
    freezeAdmissions(): Promise<{ release(): Promise<void> }>;
    readActivity(): Promise<{ native: RuntimeActivity; external: RuntimeActivity }>;
  };
  reconcileBeforeAdmission(): Promise<void>; // new admission remains fenced on uncertain result
}
async function createCoreAuthority(options: {
  installationId: string;
  profileRoot: string;
  zcodeBuiltinProviderConfigFilePath: string;
}): Promise<CoreAuthorityComposition>;
```

Core currently uses `createLocalServices` and `CoreMaintenanceAdmission` with an optional injection; production entry must import a real composition adapter, never a false-idle default. service-boot/native-facts/maintenance-lease supply the actual source ports; core-boot owns IPC lifecycle/lease and boot. Exact exported name is negotiable before integration, not a request for other groups to edit Core files.

Typed port committed at `0f90e40dc339355f8c3f0e25238132786d8d1971` in `packages/zcode-server-cli/src/server-core/authority.ts`. `@zcode/services/node` must export `createCoreAuthority(options: CoreAuthorityOptions): Promise<CoreAuthority>` from its PUBLIC entry, with admission initially closed, only opening after `reconcileBeforeAdmission()` resolves. Its `services` is the *single* persistent ServiceCollection and `maintenance` freezes both native and external admission. Required `dispose()` closes Catalog/Target writer and service resources once; Core invokes it on HTTP boot failure and shutdown. `profileRoot` supplied by Core is installation-scoped. No implementation export is available in this checkout: Core will refuse readiness rather than mount a duplicate legacy collection.
