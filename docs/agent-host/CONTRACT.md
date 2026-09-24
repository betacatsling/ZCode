# Multi-harness session host contract (implementation spec)

Source plan: `ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` (sections 4, 12 and 13); it supersedes the former v0.2 pointer. See `HIERARCHY.md` and `REGISTRY.md` for the P1 shared-interface freeze. Compilation alone does not certify runtime integration.

## Rules and owners

- The existing CLI/V4 runtime is the only writer of native ZCode session, projection, command inbox and model execution state. Its legacy `glm` identity remains a **native-only** wire value; do not reuse the legacy normalizer for external sessions.
- A target-local Runtime Host owns external session identity, command admission/receipts, event journal, projection and backend bindings. The Harness owns its native context and side effects; a projector never executes tools. The selected Provider registry/model runtime owns model validation and API credentials. Renderer only holds subscriptions and optimistic drafts.
- New writable sessions require a target-verified Project → RepositoryBinding → WorktreeWorkspace and SessionSpecV2 `(projectId, workspaceId, targetId, workspaceIdentity, worktreeGeneration, harnessId, hostSessionId)`; no fabricated identity or path-only fallback. Legacy SessionSpec v1 remains a compatibility/read format during the transition, not valid admission for final new-session routing. Backend/native IDs never serve as host IDs. A turn freezes `(requested, effective, catalogFingerprint, adapterVersion, targetId)` before dispatch; a changed catalog cannot alter that turn.
- `host-managed` is allowed only if the actual model request traverses ZCode's existing model executor, including auxiliary calls. `harness-managed` must be labelled separately and explicitly certified by that adapter; Pi's SDK bridge does not support silently switching into native Pi account mode. A bare endpoint/key override does not prove unified routing. Unsupported and unverified capabilities are rejected, never silently guessed or replaced.
- No secrets in schema, events, diagnostics or exported traces. Workers get an isolated per-session configuration and narrow credential references. Default gateway listens on target loopback/socket with session-bound authorization.

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

## Acceptance / regression

1. Deterministic contract tests: malformed/unknown harness, model, target, duplicate IDs; streaming text, tools, approvals, duplicate/gap/late events, failures, slow backends, stale stop/approval; serialization and capability reasons.
2. Native V4 regression (create/send/tools/stop/approval/history, settings preserved), facade on/off. Existing fixtures stay valid.
3. ZCode and Pi each with two genuinely distinct Providers on macOS local and Linux SSH: read→edit→test→follow-up, with actual route trace. Pi approval denial must prevent tool execution.
4. GUI exit and SSH detach/reconnect during running task and pending approval: no replayed prompt or duplicated side effect, correct history and outcome after host crash. Same path/ID across targets remain isolated; independent worktrees for parallel writers.
5. Codex and Claude: separately verify structured event/control and host-managed model ingress against exact protocol versions; multi-turn tools, approval, cancel, resume, usage and auxiliary calls. Unsupported combos remain unavailable.
6. Build, typecheck, lint, architecture check, deterministic suite, packaged/remote-version checks, upgrade/rollback, fault and long-running load tests. Never record an unrun or environment-dependent test as passed.

## Migration / rollback

Add strict, versioned external-session metadata sidecar; infer `harness=zcode` only for existing native records. Never rewrite existing V4 sessions, provider config or credentials. Unknown future sidecar versions are not writable by old programs. Disable external new-session admission by harness/protocol independently; existing external history remains readable and the native entry remains available. Do not delete old ZCode owner/lease semantics.
