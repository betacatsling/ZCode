# Project and Worktree service boundary

The existing service collection exposes one profile-local Project Catalog and
target-local Worktree services. A remote target registers its own Worktree
service through the existing remote workspace service collection; it does not
create another profile Catalog or a Desktop Remote Host. Browser-safe
descriptors cross the existing channels, while file/Git factories stay in the
Node host.

## Owners and event order

```text
Project create (may have no workspace/default)
  → target Worktree.discover(path)
  → explicit adoption:
       existing candidate → Worktree.adopt(projectId, candidate)
       bare repository   → Worktree.adoptBareRepository(projectId, evidence)
  → target Worktree.getAvailability() + read()
  → profile ProjectCatalog.ingestTargetSnapshot(target facts + display summary)
  → ProjectCatalog.readWorkspaceCatalog(current target connection states)
```

Each step has one owner. Project metadata/defaults and cached presentation
belong to the profile Catalog. Repository bindings and worktree path,
identity, generation, verification and lifecycle belong to the target
Worktree service. A partial cross-owner failure retains the successful record
for retry; there is no compensating Git deletion or implicit binding transfer.

The profile Catalog accepts only a strict snapshot derived from the target
service's validated `read()` result. Worktree facts in the snapshot must
cross-check target, binding, workspace and Project ownership. The Catalog
stores only display-safe fields—workspace title/head/lifecycle plus optional
Host-derived session rows/counts—and timestamps; it drops execution path and
generation. A refresh updates only the requesting target. Missing workspace
rows remain as stale references, and omitted/failed session-summary reads
retain the last summary.

## Offline aggregation and authority

`readWorkspaceCatalog` combines the persisted cache with target connection
states supplied by the existing connection/service collection. Its result can
include local, connected, and offline target references. It does not register
targets, poll, write, or grant routing authority. On disconnect, callers can
mark that target offline; a read after profile-owner restart still returns its
last verified tree and summary with `offline` freshness. On reconnect, a live
connection without a successful refresh is stale. Only a fresh target read
can make the presentation live again.

No UI projection or cache can authorize session execution or attachment. The
target service must revalidate workspace identity, repository binding,
filesystem evidence and generation at the existing admission boundary. This
preserves the same-path rebuilt-generation fence. Current workspace identity
matching continues to use
`workspaceIdentity?.trim() || workspacePath`; remote identity is created and
parsed only by the existing shared helpers. `remoteSessionId` is connection
scoping data and is never a durable target ID.

Web replayable channels remain unable to mutate the profile or target
services. Desktop continuous clients may use the existing trusted service
scope. The aggregate read is additive through the current descriptors and
does not add another target registry or background daemon.
