# codex-control-proof early typed interface

HEAD at publication: `727b847` (base). No cross-owner schema or production registration changes.

Existing public adapter contract (unchanged): `CodexHarnessAdapter` implements `HarnessAdapter` (`packages/services/src/agent-host/harnessRegistry.ts`); constructor `{root:string, lease:CodexTurnLeaseIssuer, resolveTurnPlan?:(spec:SessionSpec,previous:BindingPlan,turnId:string)=>Promise<BindingPlan>, executable?:string, spawnProcess?:typeof spawn}`. `CodexTurnLeaseIssuer.issue({plan,hostSessionId,runtimeEpoch,turnId}): Promise<{token:string,modelAlias:string}>`, `gateway.revokeToken(token):void`; `createCodexGatewayLeaseIssuer({gateway,gatewayUrl})` supplies it. Manifest `codexTrustedManifest` is pinned 0.156.1. No new interface required for native Host join; `SessionHost.create({root,spec,target,catalog,registry})`, `dispatch(AgentCommand)`, `snapshot()`, `eventsSince(0)` are the test surface. No UI/Gateway/Host changes in this lane.

Proof scope: real pinned CLI → actual adapter/SessionHost → Gateway → SDK → fake local upstream; deny/allow/cancel and two model leases, row/receipt/filesystem assertions. Tests opt-in with `ZCODE_CODEX_ADAPTER_JOIN=1` and isolated temporary homes.
# claude-repair API handoff

No production cross-module API change. `createClaudeHarness(profile: TrustedClaudeProfile): ClaudeHarnessAdapter` unchanged; `send`, `terminate`, `shutdown`, `subscribe` retain HarnessAdapter signatures. Canonical `message.finished` is the existing shared schema; Claude adapter publishes user prompt at turn start and terminal assistant replacement before `turn.finished(success)`. A test-only optional `TrustedClaudeProfile.writeInflight?: (path: string, contents: string) => Promise<void>` controls the exclusive durable write boundary (default uses `writeFile(..., {flag:'wx',mode:0o600})`). Do not use this hook in production profiles. Shutdown mid-write emits `turn.finished(unknown)` once before detaching; send rejects; no transport launch after lease revocation.

Initial interface/spec commit: `b44b7ea785df079e2ebfa70b6c18e1617cb86673` (base `ffc9564`).

# protocol-terminal early typed interface (this lane)

Source base `02a651f`; Claude prerequisite chain integrated as `47d0fb2`, `24c5269`, `e2c02df`, `59903a5`, `67ae463`. No shared schema/new production profile. Existing `CodexHarnessAdapter` and `ClaudeHarnessAdapter` retain HarnessAdapter entrypoints; native completion matching and Claude SDK final message folding are adapter-private. Codex send/lease remain live after interrupt ACK until matching terminal or uncertain closure; Claude success needs authoritative final assistant content. Both remain unregistered/uncertified. Specs updated before code in `docs/agent-host/{CODEX-ADAPTER,CLAUDE-ADAPTER}.md`.
