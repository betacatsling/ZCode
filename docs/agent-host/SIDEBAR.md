# Lightweight Project → Workspace → Agent sidebar projection

This is a pure P1 read-model contract. It projects the target-owned hierarchy
and bounded session summaries into a three-level tree. It is not a Catalog,
session owner, journal, transport, or UI view store.

## Inputs and ownership

- `HierarchySnapshot` owns Project, RepositoryBinding, WorktreeWorkspace, and
  AgentSession membership and identity.
- A bounded session summary supplies current `activity`, `freshness`,
  `recentOutcome`, `unread`, `pendingInteractionCount`, `updatedAt`,
  `archived`, and whether a row is top-level, terminal, or internal.
- The Harness directory supplies display name, icon resolution, and whether a
  matching executable adapter is registered. It does not supply capabilities.

The projector never reads a transcript, starts a worker, probes Git, dispatches
a command, or writes state. It does not cache a second membership authority.
Unknown summaries are ignored as stale projections; hierarchy sessions without a
summary remain visible with `unknown` state rather than being marked completed.

## Output rules

The output always retains empty Projects and Workspaces. Session rows use stable
Project/Workspace/Session IDs and preserve source ordering. Each row keeps
activity, freshness, recent outcome, unread, and pending interaction fields
separate. The derived attention order is:

```text
pending interaction → error/unknown outcome → unknown state → running/waiting
→ unread completion → idle
```

Offline or stale freshness is shown independently and never becomes a success or
completed outcome. An unknown Harness uses a safe fallback icon and display
label containing the Harness ID when no manifest exists; its row is not
presented as runnable merely because it exists in the hierarchy. Workspace rows
also carry the authoritative worktree `head` (branch or detached) and a
separate `targetFreshness` input. A zero-session Workspace can therefore show an
offline target without inventing a session outcome.

Project and Workspace aggregates count all non-archived top-level sessions in
the source snapshot. Collapsing, hiding, paging, or filtering rows cannot reduce
the aggregate counts. `runningCount` follows the independent activity field;
`errorCount` counts confirmed failed outcomes; `unknownCount` remains separate.
Terminal views and internal child sessions do not inflate the top-level Agent
count or appear twice. Pending/error attention remains reachable through the
parent aggregate even when a Workspace is hidden.

The projector does not own focus, expanded state, drafts, scroll position, or
sorting preferences. Those remain a later UI view-store concern.

## Fixture and acceptance boundary

The deterministic fixture contains two Projects, two Workspaces under each
Project, and three sessions in one Workspace including two Pi sessions. Tests
cover unknown/offline summaries, missing manifests, pending/error/unread counts,
archived/terminal/internal exclusion, empty nodes, and stable identity. This
fixture proves projection semantics only; it is not evidence of live Harness,
Git discovery, remote persistence, or GUI behavior.
