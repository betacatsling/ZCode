import type { PackagedTargetServer } from "./targetServerProcess.js";

/** Main transports identity and location only; no mutable task/session truth lives in this record. */
export interface LocalCoreEndpoint {
  readonly endpoint: string;
  readonly installationId: string;
  readonly version: string;
  readonly generation: number;
}

/** Resolves an owned, packaged CLI; never falls back to a source-tree or a window executor. */
export interface LocalCoreAttachmentSource {
  resolvePackagedServer(): Promise<PackagedTargetServer>;
  prepare(server: PackagedTargetServer): Promise<LocalCoreEndpoint>;
}
