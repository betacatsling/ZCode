# Codex pinned Host adapter — bounded support

Owner: target-local Codex adapter owns native process/thread, per-turn Gateway lease, approval callback association and ordered canonical event sequence. Host owns command admission, durable journal, workspace verification, model selection and persisted backend binding; Gateway owns credential authorization and immutable captured Model. UI never supplies an executable or Gateway token.

Trust: only manifest `{schemaVersion:1,id:'codex',name:'Codex',adapterVersion:'0.156.1'}` may be registered by target composition. Probe exact `codex-cli 0.156.1` on the actual target. No native-account fallback. Host-managed Responses with explicit reasoning `off` only; a high binding is unsupported before effect. Other tools/features not tested are not advertised. The pinned CLI still injects developer skills/permissions; Gateway must preserve roles. No paid Provider call is part of this certification.

Each admitted turn obtains a newly issued lease for its Host turnId and runtimeEpoch from the injected target-local issuer (captured exact Model, unique alias, bounded limits). The adapter starts a *new* isolated app-server process with that token and resumes the prior native thread ID using the same private profile after the first turn. On completion/interrupt/error revoke token and close the process before another send; no prompt replay. Never edit the token in a running child or reuse a previous turn token. If resume fails, mark execution unknown rather than creating a new thread. Late notifications/callbacks from an obsolete child may not advance the next turn. A token must be revoked even when launch fails. `thread/start` creates context once, `thread/resume` retains context; a fake SSE exchange alone does not prove context quality.

```
Host accepted send → lease(turn, epoch, frozen Model) → spawn pinned child → native start/resume → turn/start
native approval → canonical interaction.requested → Host durable decision → native reply
native completed/interrupt/error → revoke token → child close → next turn may lease/restart/resume
```

Canonical text/tool/interaction/usage/finish events are sequenced within the adapter and validated by Host journal. Native thread/turn IDs are not Host IDs. Unknown or late approvals decline. Cancel races must not turn a subsequent turn into success. On restart after process death, Host uncertain command rules win: no automatic resend of accepted turns. If native history cannot be verified, adapter attach refuses execution. History-only remains readable through Host journal.

Acceptance: fake child validates distinct tokens and exact turn scopes, late request rejection, approval deny, cancel, resumed thread without replay and two distinct models; opt-in real pinned CLI + actual Gateway + fake upstream exercises both turns. Desktop/mobile projections share the same Host sequence; desktop continuous and mobile replayable delivery are Host responsibilities, not parallel adapter queues.
