// Desktop Main uses these public target-install primitives when it launches the
// existing Supervisor. Keep this entry independent from the CLI command tree.
export { currentServerTarget } from "./runtime/manifest.js";
export type { ServerTarget } from "./runtime/manifest.js";
export { resolveServerLayout } from "./runtime/paths.js";
export type { ServerLayout } from "./runtime/paths.js";
export { serverStatusSchema } from "./contracts.js";
export type { ServerStatus } from "./contracts.js";
