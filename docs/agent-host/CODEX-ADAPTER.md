# Codex pinned Host adapter — bounded support

Owner: target-local Codex adapter owns native process/thread, per-turn Gateway lease, approval callback association and ordered canonical event sequence. Host owns command admission, durable journal, workspace verification, model selection and persisted backend binding; Gateway owns credential authorization and immutable captured Model. UI never supplies an executable or Gateway token.

Trust: only manifest `{schemaVersion:1,id:'codex',name:'Codex',adapterVersion:'0.156.1'}` may be registered by target composition. Probe exact `codex-cli 0.156.1` on the actual target. No native-account fallback. Host-managed Responses with explicit reasoning `off` only; a high binding is unsupported before effect. Other tools/features not tested are not advertised. The pinned CLI still injects developer skills/permissions; Gateway must preserve roles. No paid Provider call is part of this certification.

Each admitted turn obtains a newly issued lease for its Host turnId and runtimeEpoch from the target-local issuer (captured exact Model, unique alias, bounded limits). An optional Host-authoritative `resolveTurnPlan` supplies the next turn's exact binding; absent that, the initial plan remains pinned. Never use mutable global model selection or a caller-provided Model override. The adapter starts a _new_ isolated app-server process with that token and resumes the prior native thread ID using the same private profile after the first turn. On completion/interrupt/error revoke token and close the process before another send; no prompt replay. Never edit the token in a running child or reuse a previous turn token. If resume fails, mark execution unknown rather than creating a new thread. Late notifications/callbacks from an obsolete child may not advance the next turn. A token must be revoked even when launch fails. `thread/start` creates context once, `thread/resume` retains context; a fake SSE exchange alone does not prove context quality.

```
Host accepted send → lease(turn, epoch, frozen Model) → spawn pinned child → native start/resume → turn/start
native approval → canonical interaction.requested → Host durable decision → native reply
native completed/interrupt/error → revoke token → child close → next turn may lease/restart/resume
```

Canonical text/tool/interaction/usage/finish events are sequenced within the adapter and validated by Host journal. Native thread/turn IDs are not Host IDs. Unknown or late approvals decline. Cancel races must not turn a subsequent turn into success. On restart after process death, Host uncertain command rules win: no automatic resend of accepted turns. If native history cannot be verified, adapter attach refuses execution. History-only remains readable through Host journal.

Acceptance: fake child validates distinct tokens and exact turn scopes, late request rejection, approval deny, cancel, resumed thread without replay and two distinct models; opt-in real pinned CLI + actual Gateway + fake upstream exercises both turns and confirms an old token is unauthorized after Model change. The separate `codexGatewayJoin.test.ts` runs a real native command denial and cancellation; the new adapter's native two-turn join uses text turns, not a real native approval or cancellation. Pinned Codex warns that unknown per-turn aliases use fallback model metadata and that changing aliases across thread resume may affect performance: this is a compatibility/performance risk, not proven equivalence with the native model's behavior. This adapter is not registered into production composition in this lane. Desktop/mobile projections share the same Host sequence; desktop continuous and mobile replayable delivery are Host responsibilities, not parallel adapter queues.

## Pinned native control acceptance (this lane)

The target-local SessionHost alone admits commands/records receipts and journals adapter events; CodexTransport alone associates native thread/turn and approval callback; the adapter owns the per-turn lease and process. No UI or Gateway writes the Host journal. Test with the installed exact `codex-cli 0.156.1`, private temporary HOME/CODEX_HOME and localhost fake Responses upstream (no Provider calls):

```
Host send(id, turn) → journal accept → adapter lease(epoch,turn,Model) → native start/resume
adapter turn.started → accepted user message.finished → native function call → approval callback → adapter interaction.requested → Host journal → Host resolve(id,epoch,turn) → native accept/decline
native completion → canonical rows → lease revoke → process close → next turn may start
Host cancel(id,epoch,turn) → native interrupt → revoke → no success; old token 401
```

Verify deny does not write a file; allow reaches the native filesystem and the resulting canonical Host tool/interaction/assistant rows are durable; active cancellation against a held upstream response does not finish successfully and revokes the lease; resumed selected second Model sees prior context and old token cannot access the new route. All commands use unique IDs, and stale turn/epoch or duplicate decisions cannot authorize native callbacks. Missing tool approval, silent execution, unsupported pinned binary or uncertain process outcome blocks capability promotion; a raw transport-only callback does not count as Host proof. No production registration or wider Codex version/capability claim follows automatically from this isolated test.
