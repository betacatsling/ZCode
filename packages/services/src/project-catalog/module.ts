/** Project Catalog owns only durable project metadata and user-managed references/preferences. */
export const projectCatalogModule = {
  id: "project-catalog",
  requires: ["shared"],
  provides: ["project-catalog-service"],
  publicEntrypoints: ["contract.ts", "index.ts"],
} as const;
