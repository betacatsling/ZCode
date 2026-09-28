/** Target-local worktree identity, explicit creation/removal, and admission fence. */
export const worktreeModule = {
  id: "worktree",
  requires: ["shared"],
  provides: ["worktree-service"],
  publicEntrypoints: ["contract.ts", "removalContract.ts", "index.ts"],
} as const;
