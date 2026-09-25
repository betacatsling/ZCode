# Accepted controls at an external target

## Owner and contract

`AgentHostTargetService` owns routing between workspace admission and an already mounted `SessionHost`; only `SessionHost` owns accepted commands, runtime epoch/turn, approvals and receipts. `WorkspaceAdmissionPort.verify/withAdmission` remains the **new execution** gate, including archive, freeze, actual Git generation and contained cwd. No second command queue or speculative owner is introduced. The public `IAgentHostService` command/read signatures do not change.

## Rules

- `create`, `attach`, NEW `send`, `resumeExecution`, and an approval `allow` require the live workspace admission gate; stale/removed/rebuilt scopes cannot execute a new turn or tool. A previously accepted command ID on the exact persisted mounted Host may reach its journal's duplicate check before admission: only an identical payload yields a duplicate receipt, never another adapter invocation. A conflicting payload rejects, and an absent ID must pass admission. Identical completed create retries are answered from the durable creation journal before admission, including when the feature flag is off. Conflicting/unknown receipts never execute.
- `cancelTurn` and `resolveInteraction: deny` for an already mounted, persisted exact session bypass **only** the new workspace admission check. They still require the target, complete stored spec, attached Host ownership, and Host journal validation of command ID, epoch, turn and interaction; no cold start or adapter attach from a control request. Archive/freeze/removed worktree must not strand a pending denial or cancellation. `detach`, `viewHistory`, `terminateSession` retain exact persisted owner checks; `allow` remains admission-gated.
- History/snapshot/rows/events/command query are read-only and never call workspace admission or launch an adapter, including after feature-off and path replacement. The lazy wrapper must not initialize a worker merely to answer a control/history request while the feature is off.
- A new external command may start lazy Registry initialization while admission is open; if boot/maintenance closes admission during that await, it must not continue into adapter import/factory or create a target. The same workspace admission remains the final execution guard, including after all asynchronous preparation. Read-only history remains usable during the hold. The Registry refresh is configuration IO, not a Model/tool turn. Read-only catalog queries may still initialize the catalog without creating a session; only execution callers require the post-await hold recheck (a concurrent read is not evidence of execution). The Host journal alone owns accepted external commands: after a cold restart an accepted send is reported execution-unknown, never automatically dispatched by history or boot, and a fresh turn cannot erase its uncertainty. CLI ordinary accepted inputs remain in the CLI CommandInbox, not this Host journal.

```text
external new input → lazy Registry await → recheck Core boot/maintenance hold → adapter activation → Target workspace admission → Host durable accepted receipt → backend
boot/maintenance hold ──────────────────────────┘                                  └─ cold restart: read-only unknown, no replay
```

- No capability advertisement for a removed/archived scope as writable. A mounted Host owns its epoch; an unrelated caller cannot forge a new Host binding via the control path.

## Usage admission atomicity

The event journal is the sole durable history owner. Its in-memory usage index is derived, not a second ledger: rebuild once from committed events on open, and on the serialized append tail validate a usage transition against that index *before* durableAppend. Apply the prepared transition only after cursor publication succeeds. The projector replays the same pure transition rule; it never authorizes an append. Identity is `(turnId, sourceId)` within one journal epoch; legacy unscoped events cannot mix with scoped usage in a turn. An absolute snapshot may introduce a previously unknown metric, but cannot omit or decrease any metric already known for that source. Delta is once-only; collisions in source kind or accounting mode fail closed. Unknown is not zero. A duplicate source event with identical bytes is idempotent and has no usage transition. Validation rejection must leave committed history readable, the next legitimate sequence usable, and must not poison writes; a durability failure instead fences future append because disk commit status is uncertain. Neither case replays an accepted command; Host event-gap policy remains execution-unknown. Per-event admission is O(1) in history length (bounded five usage fields); open replay is O(history length). No Host import of projection domain or lock recovery change.

```
source event → EventJournal serialized tail → schema/scope/sequence/idempotency
             → pure prepared usage transition → durable append + cursor
             → apply in-memory index → Host publish / desktop continuous
                                           └→ mobile replayable reads same committed cursor
reopen → committed journal replay → same usage transition → derived index
```

Acceptance: Host-level omitted/decreasing known metric RED before repair; unknown→known, same-source idempotence/collision, cross-turn isolation; invalid source cannot poison history/snapshot or next committed sequence; failure to persist never applies the index and fences subsequent writes. Unknown turn after a bad source remains no-replay. No Core journal-lock recovery is claimed.

## Event order / acceptance

```
accepted send -> durable command -> mounted Host turn/approval
archive or remove -> new admission denied
control / known-ID retry -> target+persisted spec+mounted owner -> Host durable command -> duplicate or epoch/turn/interaction check -> adapter deny/cancel
new allow request -> live workspace/Git generation held gate -> Host durable command -> adapter allow
```

Desktop continuous events and mobile replayable events share this Host journal; neither control nor history spawns a separate worker. Tests cover archived running and waiting, accepted send/allow duplicate vs conflicting and new IDs, stale turn, missing/rebuilt tree, cold control rejection, and feature-off history/identical create retry without worker initialization.
