# Session hierarchy module contract

The module reads persisted task/session locators through `SessionIndexPort`,
matches them against target-owned adopted Worktree facts, and writes a strict
metadata-only sidecar after explicit apply. It preserves native session IDs,
never starts an Agent or reads transcript bodies, and keeps unresolved records
pending verification. Apply re-reads both source ports while holding the
sidecar lock, so a preview token cannot write a stale source snapshot.
Persistence uses the existing lock/atomic-file adapter, keeps the prior
sidecar in a versioned `.bak` record, and exposes a revision-guarded rollback
that affects only this metadata sidecar. The apply baseline is explicit:
`expectedCurrentRevision` is a command key or `null` for the first write.

`ownerKind` separates `native-v4` task IDs from `agent-host` persisted
`hostSessionId` values. Current membership reads retained workspace history
across generations from Native's existing-only owner index, confirmed creation
receipts, and target-local manifests. It does not start a CLI, attach a worker,
load a model, or read conversation history.
The target Worktree discovery port resolves a persisted cwd/subdirectory to a
specific Git worktree root; nested repositories are resolved by Git discovery,
not path-prefix guessing. The resolved root is matching evidence only: the
sidecar preserves the original owner workspace path and cwd scope. Native-v4
records may link without a copied model selection; the native owner remains
the model authority. AgentHost records rely on the manifest binding kind,
including `harness-managed`, rather than inventing a host model selection.

Current membership includes archived, missing, removed, and unverified
Worktree rows. Only an exact owner generation associated with an active,
verified workspace is linked. Other managed owner facts remain
`pending-verification` with their original locator and
`ownerHistoryAssociation`; that field is history-only and grants no execution.
A workspace ID whose generation advanced remains discoverable at its original
generation. A linked `ownerAssociation` indicates exact workspace membership,
not live runtime state or an execution grant.

Receipt-only Native rows retain the creation ID and locator but stay pending
with `owner-state-unknown`. A confirmed receipt does not imply that the Native
owner is running or that the session completed. New receipts persist the
original filesystem path. A legacy receipt without that path is used only when
the retained Worktree still has the same generation; it is never assigned the
path of a rebuilt generation. Existing sidecar history remains untouched.
