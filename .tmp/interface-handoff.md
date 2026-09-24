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

Early spec commit SHA: `d071921e06af23e3bb4915584a5a791f9b4a2cd0`.
