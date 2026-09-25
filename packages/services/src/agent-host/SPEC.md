# Accepted controls at an external target

## Owner and contract

`AgentHostTargetService` owns routing between workspace admission and an already mounted `SessionHost`; only `SessionHost` owns accepted commands, runtime epoch/turn, approvals and receipts. `WorkspaceAdmissionPort.verify/withAdmission` remains the **new execution** gate, including archive, freeze, actual Git generation and contained cwd. No second command queue or speculative owner is introduced. The public `IAgentHostService` command/read signatures do not change.

## Rules

- `create`, `attach`, NEW `send`, `resumeExecution`, and an approval `allow` require the live workspace admission gate; stale/removed/rebuilt scopes cannot execute a new turn or tool. A previously accepted command ID on the exact persisted mounted Host may reach its journal's duplicate check before admission: only an identical payload yields a duplicate receipt, never another adapter invocation. A conflicting payload rejects, and an absent ID must pass admission. Identical completed create retries are answered from the durable creation journal before admission, including when the feature flag is off. Conflicting/unknown receipts never execute.
- `cancelTurn` and `resolveInteraction: deny` for an already mounted, persisted exact session bypass **only** the new workspace admission check. They still require the target, complete stored spec, attached Host ownership, and Host journal validation of command ID, epoch, turn and interaction; no cold start or adapter attach from a control request. Archive/freeze/removed worktree must not strand a pending denial or cancellation. `detach`, `viewHistory`, `terminateSession` retain exact persisted owner checks; `allow` remains admission-gated.
- History/snapshot/rows/events/command query are read-only and never call workspace admission or launch an adapter, including after feature-off and path replacement. The lazy wrapper must not initialize a worker merely to answer a control/history request while the feature is off.
- A new external command may start lazy Registry initialization while admission is open; if boot/maintenance closes admission during that await, it must not continue into adapter import/factory or create a target. The same workspace admission remains the final execution guard, including after all asynchronous preparation. Read-only history remains usable during the hold. The Registry refresh is configuration IO, not a Model/tool turn. The Host journal alone owns accepted external commands: after a cold restart an accepted send is reported execution-unknown, never automatically dispatched by history or boot, and a fresh turn cannot erase its uncertainty. CLI ordinary accepted inputs remain in the CLI CommandInbox, not this Host journal.

```text
external new input → lazy Registry await → recheck Core boot/maintenance hold → adapter activation → Target workspace admission → Host durable accepted receipt → backend
boot/maintenance hold ──────────────────────────┘                                  └─ cold restart: read-only unknown, no replay
```

- No capability advertisement for a removed/archived scope as writable. A mounted Host owns its epoch; an unrelated caller cannot forge a new Host binding via the control path.

## Event order / acceptance

```
accepted send -> durable command -> mounted Host turn/approval
archive or remove -> new admission denied
control / known-ID retry -> target+persisted spec+mounted owner -> Host durable command -> duplicate or epoch/turn/interaction check -> adapter deny/cancel
new allow request -> live workspace/Git generation held gate -> Host durable command -> adapter allow
```

Desktop continuous events and mobile replayable events share this Host journal; neither control nor history spawns a separate worker. Tests cover archived running and waiting, accepted send/allow duplicate vs conflicting and new IDs, stale turn, missing/rebuilt tree, cold control rejection, and feature-off history/identical create retry without worker initialization.
