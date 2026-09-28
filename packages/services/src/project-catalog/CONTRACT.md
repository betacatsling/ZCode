# Project Catalog module contract

`ProjectCatalogService` owns profile-local Project metadata, target-scoped
repository/workspace references, navigation defaults, and display-only last
verified presentation. Target `IWorktreeService` remains authoritative for
binding/workspace identity, execution paths, generations, and revalidation.
The Catalog never grants execution or attachment routing.

The strict persisted envelope is schemaVersion 2. Valid v1 files migrate in
memory; their targetless IDs remain `needsVerification` and are not assigned to
a connected Host. Future versions fail closed without a write. Each mutation
holds the existing lock across read, migration, validation, and atomic replace.
Target ingestion updates only the supplied target and preserves missing or
offline presentations; it does not change Project defaults. Host-summary
freshness is independent from Worktree snapshot freshness; a Worktree-only read
retains old activity as stale instead of revalidating it.

`readWorkspaceCatalog` returns a separate strict read-only schemaVersion 1
model. It overlays current connection states supplied by the existing service
collection and creates no target registry. Window selection/expansion remain
in the window store, and all cached presentation remains non-executable.
