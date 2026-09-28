/**
 * Feature flag for **new** external multi-harness session admission.
 *
 * - Enabled only when `ZCODE_MULTI_HARNESS_ENABLED` is exactly `"1"`.
 * - Unset / `"0"` / `"true"` / any other value → disabled (fail closed).
 * - Does not reassign running owners, rewrite native V4 sessions, or gate
 *   history/cold reads that the Host already allows without admission.
 * - Priority vs other gates: target `available`, worktree authorize, and
 *   per-harness probe still apply after this flag is on.
 */
export function isMultiHarnessNewSessionAdmissionEnabled(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.ZCODE_MULTI_HARNESS_ENABLED === "1";
}
