# service-boot early contract

Base 8086fc5. The writable composition is restricted to `standalone-server` (Core only); desktop-local must attach over the existing Core RPC descriptor. `createLocalServices` requires an explicit `agentHostTargetId` and complete native production facts for a writable mount. The planned `createLazyWorkspaceComposition` accepts a mandatory boot reconciliation function sourced from durable Target receipts, gates NEW admission until it resolves, and leaves read/history paths reachable; no Git retry on boot. Native bridge contract is `Pick<CompositionOptions, "nativeIndex" | "native" | "nativeActivity" | "nativeAdmissionFence">`; identity and remote session resolver are target-scoped. Missing bridge or reconciliation => read-only, never success. Other owners should export typed native and receipt public factories; no mutations to their files from this lane.

Sequence: Core owner -> Target/Catalog open -> durable receipt/archive reconciliation -> NEW admission enabled; failed reconciliation -> diagnostics/readable history only. Window Local Host -> Core RPC only.

Typed Node composition contract (source: `packages/services/src/workspace-hierarchy/lazyComposition.ts`):
```ts
type NativeProductionFacts = Pick<CompositionOptions,
  "nativeIndex" | "native" | "nativeActivity" | "nativeAdmissionFence">;
// createLocalServices({serviceAuthorityMode: "standalone-server", agentHostTargetId,
//   workspaceCompositionRoot: absoluteProfileRoot, workspaceComposition: nativeFacts})
// createLazyWorkspaceComposition(options: CompositionOptions): {
//   agentHost; catalog; hierarchy; maintenance; ready(): Promise<void>; dispose(): Promise<void>
// }
```
Core should await `ready()` through an exported Node getter before advertising new admission. Target receipts must be authoritative: `ProjectCatalog.reconcilePending()` and `.reconcileArchivePolicies()` are invoked once after open; boot failure is sticky. No window owns catalog.

Implemented service-boot source SHA: `9e139d6159b553159090a5e3fef31deda66035f7`.
Core imports `getWorkspaceCompositionReady(services): Promise<void>` from `@zcode/services/node` and awaits it after `createLocalServices({...})`; `workspaceCompositionTarget?: ExecutionTarget` identifies local vs authenticated SSH (not inferred from Linux). The production bridge input MUST be real `NativeProductionBridge`, never the sample test facts. Core must supply `workspaceCompositionRoot` and `workspaceComposition`; malformed inputs throw before startup side effects. New session admission stays disabled before boot, while reads are live; no boot replay after rejection. `getWorkspaceMaintenanceCoordination` is still the existing local callback port, not an IPC lease.

Blocking integration interfaces (not yet implemented in this checkout): native-facts `createNativeProductionBridge` currently throws `native-production-bridge-not-implemented` at c90f18c; Core entry currently creates services with target ID but no root/bridge and thus fails preflight. Target-receipts 2ee18c7 implements durable lookup but is not yet merged here. Core must mount the native-facts configured DB/runtime port plus target receipts and await `getWorkspaceCompositionReady`; no fake idle/empty index.
