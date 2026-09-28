export const sessionHierarchyModule = {
  id: "session-hierarchy",
  requires: ["shared"],
  provides: ["session-hierarchy-service"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
