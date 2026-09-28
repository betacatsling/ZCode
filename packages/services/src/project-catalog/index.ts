export * from "./contract.js";
export { createProjectCatalogService } from "./app/projectCatalogService.js";
export { createFileProjectCatalogRepository } from "./adapters/fileProjectCatalogRepository.js";

import { createProjectCatalogService } from "./app/projectCatalogService.js";
import { createFileProjectCatalogRepository } from "./adapters/fileProjectCatalogRepository.js";
import type { IProjectCatalogService } from "./contract.js";

export function createFileProjectCatalogService(filePath: string): IProjectCatalogService {
  return createProjectCatalogService({
    persistence: createFileProjectCatalogRepository(filePath),
  });
}
