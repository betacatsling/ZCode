import { worktreeCatalogFileSchema, type WorktreeCatalogFile } from "../contract.js";

export function emptyWorktreeCatalogFile(): WorktreeCatalogFile {
  return { schemaVersion: 1, bindings: [], workspaces: [], creationReceipts: [] };
}

export function parseWorktreeCatalog(value: unknown): WorktreeCatalogFile {
  return worktreeCatalogFileSchema.parse(value);
}
