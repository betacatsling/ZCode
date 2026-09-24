# codex-control-proof early typed interface

HEAD at publication: `727b847` (base). No cross-owner schema or production registration changes.

Existing public adapter contract (unchanged): `CodexHarnessAdapter` implements `HarnessAdapter` (`packages/services/src/agent-host/harnessRegistry.ts`); constructor `{root:string, lease:CodexTurnLeaseIssuer, resolveTurnPlan?:(spec:SessionSpec,previous:BindingPlan,turnId:string)=>Promise<BindingPlan>, executable?:string, spawnProcess?:typeof spawn}`. `CodexTurnLeaseIssuer.issue({plan,hostSessionId,runtimeEpoch,turnId}): Promise<{token:string,modelAlias:string}>`, `gateway.revokeToken(token):void`; `createCodexGatewayLeaseIssuer({gateway,gatewayUrl})` supplies it. Manifest `codexTrustedManifest` is pinned 0.156.1. No new interface required for native Host join; `SessionHost.create({root,spec,target,catalog,registry})`, `dispatch(AgentCommand)`, `snapshot()`, `eventsSince(0)` are the test surface. No UI/Gateway/Host changes in this lane.

Proof scope: real pinned CLI → actual adapter/SessionHost → Gateway → SDK → fake local upstream; deny/allow/cancel and two model leases, row/receipt/filesystem assertions. Tests opt-in with `ZCODE_CODEX_ADAPTER_JOIN=1` and isolated temporary homes.
