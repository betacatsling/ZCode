# Multi-harness session host contract (implementation spec)

Source plan: `../../ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` (2026-09-24, baseline `328c1a0`). The hierarchy slice is specified in `HIERARCHY.md`. This document is the local implementation contract; acceptance is governed by the full source plan, not by merely compiling these interfaces.

## Rules and owners

- The existing CLI/V4 runtime is the only writer of native ZCode session, projection, command inbox and model execution state. Its legacy `glm` identity remains a **native-only** wire value; do not reuse the legacy normalizer for external sessions.
- A target-local Runtime Host owns external session identity, command admission/receipts, event journal, projection and backend bindings. The Harness owns its native context and side effects; a projector never executes tools. The selected Provider registry/model runtime owns model validation and API credentials. Renderer only holds subscriptions and optimistic drafts.
- Sessions are identified by `(targetId, workspaceIdentity || worktreePath, harnessId, hostSessionId)`. Backend/native IDs never serve as host IDs. A turn freezes `(requested, effective, catalogFingerprint, adapterVersion, targetId)` before dispatch; a changed catalog cannot alter that turn.
- `host-managed` is allowed only if the actual model request traverses ZCode's existing model executor, including auxiliary calls. `harness-managed` must be labelled separately and explicitly certified by that adapter; Pi's SDK bridge does not support silently switching into native Pi account mode. A bare endpoint/key override does not prove unified routing. Unsupported and unverified capabilities are rejected, never silently guessed or replaced.
- No secrets in schema, events, diagnostics or exported traces. Workers get an isolated per-session configuration and narrow credential references. Default gateway listens on target loopback/socket with session-bound authorization.

### Admission lease invariant

The target-local service is the sole owner of the live external-session map. A session's durable key is `(targetId, workspaceIdentity.trim() || worktreePath, harnessId, hostSessionId)`. Because the current adapter contract sends live commands by `hostSessionId`, the target service also holds a single owner lease for that ID; two workspaces cannot concurrently bind the same ID to different live backends. The composite key remains the boundary for manifests, journals and history, so different IDs and workspaces cannot collide on persisted state.

`create` and `attach` share a per-`hostSessionId` admission lane. The lane is acquired before any `await` that verifies a worktree or starts a backend, and the owner map is updated only after the `SessionHost` has mounted. A failed verification, plan, journal open or adapter start releases the in-flight reservation and does not leave a partial owner. An `attach` queued behind a successful `create` reuses that mounted host; it never starts a second backend. A duplicate or cross-workspace ID receives an explicit rejection after the current owner is visible. This is an admission lane, not a second durable command queue.

Target close first rejects new admissions, then waits for lanes already in flight, shuts down adapters, and closes mounted hosts. It does not cancel or replay accepted commands. An adapter start reserves its own `hostSessionId` before asynchronous spawn, clears that reservation on failure, rejects a concurrent direct attach while that reservation is active, and rejects a completion that arrives after adapter shutdown; this prevents two Pi workers or a stale worker from becoming the owner.

The admission lane is process-local. It does not certify cross-process fencing or crash recovery; those remain part of the P4 target-host work and require a durable owner/lease protocol.

## Read-only target activity index

`IAgentHostService.listActivityIndex()` is a target-owned read port. It
enumerates every manifest for the fixed target, without filtering through
Project/Worktree membership, archive, hide, or adoption state. Each entry uses
the full target/workspace/harness/session key and carries `runtimeEpoch`,
event `sequence`, `activeTurnId`, pending interaction IDs, and
`idle | busy | unknown`. It reads only manifests and the atomic bounded
activity projection; it does not read event/transcript journals, command
payloads, credentials, Providers, Harness adapters, or workers. A missing or
invalid projection is `unknown` and stays busy. A complete target scan clears
only target enumeration uncertainty.

The projection is written busy before durable acceptance can dispatch a
send. It becomes idle only after the matching terminal event and accepted
command receipt are durable. A Core subscribes before reading the index,
ignores event duplicates/older sequences, and replays buffered events only
after the indexed epoch/sequence fence. Epoch mismatch, sequence gaps, and
unmatched `turn.finished` events keep activity unknown until a fresh complete
index resolves the owner. `session.error`, interruption, and approval
resolution are not terminal facts. Only a matching `turn.finished` or a
same-epoch owner `session.status: idle` can release the indexed turn.

History reads validate manifest identity but do not require the worktree path
to exist. Create, attach, and send continue to require current target and
realpath/workspace authorization.

## Commands and event order

```text
client commandId -> target Runtime Host durable accepted record -> adapter dispatch
                                                -> backend receipt (or execution-unknown)
backend event(source id) -> dedup -> journal(epoch, seq) -> projector -> snapshot/delta
client detach -> unsubscribe only; cancelTurn(expected turn) -> stop that turn only
client reconnect -> query command receipt + snapshot/seq replay; NEVER resend prompt
```

The host persists admission **before** dispatch. A crash after dispatch but before backend confirmation requires reconciliation or `execution-unknown`, never blind retry. A session with an unconfirmed prior `send` cannot accept a _new_ prompt until an explicit, proven recovery path resolves that uncertainty; `viewHistory`, `detach` and explicit termination remain available. Event sequence is monotonically increasing per `(session, runtimeEpoch)`; duplicates do not create a second effect; gaps request snapshot. Late cancellations and approvals require matching turn/interaction and epoch. Approval must be backed by a real gate before the tool executes; an advisory GUI button is forbidden. Failed/resolved approvals cannot run twice. Structured lifecycle determines completion, not stdout text. A final message replaces accumulated deltas instead of appending twice. Tool JSON commits only once complete.

Desktop `continuous` and mobile `replayable` subscribers have different delivery modes but the same authoritative host sequence. Disconnect and closing a window detach; explicit termination is distinct. Target-host stdout must be drained and journaled while GUI is offline. Future schema versions are read-only to old owners; a feature flag gates new admission only, never reassigns a running owner.

## Harness control and model binding

The adapter contract includes probe, create, attach, send, cancel, resolve interaction, resume, terminate, subscribe, capabilities and explicit unsupported results for unavailable optional operations. Target execution is a separate dependency, not a per-harness × per-target subclass. Native ZCode is forwarded through the existing V4 transport; external adapters use canonical events projected to the supported V4 subset. Capability checks occur both at UI and server admission.

Pi uses a pinned SDK in an isolated target-local worker, its own agent loop and tools, with a provider bridge to the ZCode model executor. Codex uses pinned app-server for control/events and a Responses ingress for host-managed binding. Claude Code uses pinned structured SDK/stream or ACP for control/events and Anthropic Messages ingress for host-managed binding. Both external CLIs use isolated profile/overrides, never mutate global settings. Gateway rejects unsupported protocol features rather than dropping them. Underlying subscription credentials are never reused for unrelated providers.

`SessionSpec.modelBinding` is the durable model intent. The creation plan is only the initial backend-creation fact; every new `send` captures one current ModelCatalog snapshot, validates the same snapshot, plans against its fingerprint, and binds the Model from that snapshot. `SessionHost` performs this deterministic preparation inside `CommandJournal`'s existing serialized admission callback, then asks the Harness to prepare its idle turn route. Only after both succeed does the journal durably accept the command. A deterministic unsupported route, missing/invalid credential source, stale catalog snapshot, or failed Harness preparation is recorded as `rejected` before any prompt or Model request. A duplicate command returns its existing receipt without repeating binding or preparation. Once accepted, dispatch failures whose side effects cannot be ruled out remain `execution-unknown`; no input is blindly replayed.

The accepted send's journal record owns a compact audit fact: requested intent, effective selection, route, target, harness/version, catalog fingerprint, and non-secret credential-source kind. It contains no Model object, API key, bearer token, or endpoint secret. The Model object and full immutable BindingPlan remain in memory for that turn. Config/default/catalog updates affect only a later send. They do not replace an accepted turn's Model or abort it merely because an unrelated catalog revision changed. If the selected intent is no longer valid because its required credential/model was revoked, the existing Model request fails closed; explicit stop still follows the exact active-turn fence. No hidden fallback or route migration is allowed.

```text
send command -> CommandJournal admission lane -> capture catalog snapshot
             -> plan + bind Model from that snapshot -> Harness idle preflight
             -> persist accepted command + binding fact -> dispatch once
                                                        -> frozen turn Model
next send -> capture current snapshot again --------------------------^
```

Pi keeps one native worker/session/history per Host session. Its existing model-request IPC resolves against the active Host turn's frozen Model; ending that turn releases the reference. A same-worktree session with another intent has a different worker and binding. Codex keeps its opaque app-server thread/history. Its grant may be renewed only for the same immutable route/fingerprint, and a Host-owned turn lease keeps authorization available during long tools while the GUI is offline. When a later idle send has a changed binding or an expired grant, the adapter rotates the bearer token and reconnects only that session's app-server using the official `thread/resume` request with the existing opaque thread ID; it does not replay prompt text or touch global config. Active-turn bindings never change. Unsupported reasoning/signature/protocol semantics reject with history intact.

Codex's public approval interaction ID includes the originating Host runtime epoch and Host turn in addition to an opaque unique component; the exact native JSON-RPC ID remains private for the response. Reused JSON-RPC IDs after `thread/resume` cannot address a later Host interaction. V4 must resolve the interaction from the current snapshot and the Host must verify the same interaction/turn/epoch; concurrent allow/deny keeps one winner.

## Acceptance / regression

1. Deterministic contract tests: malformed/unknown harness, model, target, duplicate IDs; streaming text, tools, approvals, duplicate/gap/late events, failures, slow backends, stale stop/approval; serialization and capability reasons.
2. Native V4 regression (create/send/tools/stop/approval/history, settings preserved), facade on/off. Existing fixtures stay valid.
3. ZCode and Pi each with two genuinely distinct Providers on macOS local and Linux SSH: read→edit→test→follow-up, with actual route trace. Pi approval denial must prevent tool execution.
4. GUI exit and SSH detach/reconnect during running task and pending approval: no replayed prompt or duplicated side effect, correct history and outcome after host crash. Same path/ID across targets remain isolated; independent worktrees for parallel writers.
5. Codex and Claude: separately verify structured event/control and host-managed model ingress against exact protocol versions; multi-turn tools, approval, cancel, resume, usage and auxiliary calls. Unsupported combos remain unavailable.
6. Build, typecheck, lint, architecture check, deterministic suite, packaged/remote-version checks, upgrade/rollback, fault and long-running load tests. Never record an unrun or environment-dependent test as passed.

## Migration / rollback

Add strict, versioned external-session metadata sidecar; infer `harness=zcode` only for existing native records. Never rewrite existing V4 sessions, provider config or credentials. Unknown future sidecar versions are not writable by old programs. Disable external new-session admission by harness/protocol independently; existing external history remains readable and the native entry remains available. Do not delete old ZCode owner/lease semantics.
