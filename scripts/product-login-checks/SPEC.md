# Product-login source checks

This is a refactor of the existing `scripts/verify-product-login-removed.mjs`, not a new runtime authentication system.

- The public entrypoint, process exit convention, JSON keys, hard assertions and failure messages stay compatible. Only the soft inventory note is shortened.
- `source-utils.mjs` owns repository-root resolution and read-only source scanning. Check groups return ordered failure lists; only the entrypoint combines results and chooses the exit code.
- Separate groups own deleted UI/platform surfaces, locale keys, Provider UI wiring, removed legacy helpers, shared contracts, and status-field compatibility. CLI removed-command checks remain in the entrypoint.
- Checks perform no network, credential reads, application startup, source edits, or model calls. The existing `behavioral` field remains a source-checked mirror of the removed-command response; it is not an executed CLI E2E.
- Validate successful-output equivalence against the pre-refactor script, ignoring only the soft note and fixture root prefixes. In disposable source fixtures, restore forbidden surfaces/symbols and require the old and new entrypoints to reject identically. Never mutate the working repository for fault injection.
- This gate proves source boundaries only. Project-level runtime acceptance belongs to `docs/PROJECT-DELIVERY-PLAN.md` M3.
