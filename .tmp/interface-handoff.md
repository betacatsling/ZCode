# hierarchy-actions early public interface

`IWorkspaceHierarchyService.previewRemoval({workspaceId, expectedGeneration}): Promise<RemovalPreview>` delegates to existing Catalog/Target preview after target/binding and generation resolution. `pendingRecovery({workspaceId})` is read-only `status: "unresolved", reason: "target-receipts-unavailable", actions: ["inspect"]` until Target has durable receipt API; never auto-adopts. `SessionOwner.native.historyOnly` signals missing/stale original generation/binding; external v2 writable only with matching target/project/workspace/generation/path/identity. UI `SidebarActions.onPreviewRemoval(workspaceId, generation)` returns Target RemovalPreview; consuming hook owner must forward hierarchy RPC, not synthesize facts.

Early contract SHA: `0d8863dd70cf58110052624b2011e09d9133922d`
