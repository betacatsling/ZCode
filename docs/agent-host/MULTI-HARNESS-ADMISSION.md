# Multi-harness new-session admission flag

## Flag

`ZCODE_MULTI_HARNESS_ENABLED`

| Value | Effect |
| ----- | ------ |
| exactly `1` | Allow **new** external Harness session admission (Pi / Codex / Claude Code / Devin) through lazy Agent Host when other gates pass |
| unset, `0`, `true`, or any other string | Fail closed: no new external admission |

Owner of the boolean read: `isMultiHarnessNewSessionAdmissionEnabled` in `packages/shared/src/agent-host/multiHarnessAdmission.ts`. Production wiring (`packages/services/src/node.ts`, server CLI) must call that helper; do not re-implement loose truthiness.

## What it does **not** do

- Does not stop native ZCode / V4 CommandInbox ownership.
- Does not revoke or migrate already-mounted external sessions.
- Does not replace worktree `authorizeWorktree` / generation recheck, target availability, or per-harness probe / capability honesty (see e.g. `devinCapabilitiesHonesty`, `devinAcpCapabilitiesHonesty.test.ts`, `acpOpenCodeGooseHonesty.test.ts` — admission flag on ≠ caps certified).
- Does not certify live Provider, SSH persistence, or UI E2E.

## Priority (when flag is on)

1. Target available
2. Worktree authorization (path + generation + lifecycle)
3. Harness probe / BindingPlan / model admission
4. Then create/attach proceeds under existing Host journals

## Still open

Full product E2E for flag on/off (Picker / sidebar / create mount) remains P2 acceptance work. Env boolean: `multiHarnessAdmission.test.ts`. Lazy Host Pi/Codex wiring cross-check: `multiHarnessPiCodexAdmission.test.ts` (#69) — flag off → unavailable; exact `"1"` → admit with matching `adapterVersion`. Neither replaces live Provider / UI E2E.
