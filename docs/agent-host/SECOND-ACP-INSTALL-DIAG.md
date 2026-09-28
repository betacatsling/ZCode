# Second ACP — I1 install / PATH diagnosis (draft)

**Scope:** I1 only (CLI pin + PATH + how to read a failed install probe).  
**Not in this note:** I2 probe≠session-cap ops steps, I3 initialize matrix, I4 fault/upgrade handbook, L1–L4 live cert.  
**Hard rules:** docs-only; do **not** register OpenCode/Goose in `lazyTargetService`; do **not** treat this as production wiring or LIVE-CERT.

Reference checklist row: `IMPLEMENTATION.md` → P6 → install-diag / LIVE-CERT → **I1**.  
Agent inventory: `packages/services/src/agent-adapters/acp/COMPATIBILITY.md` (OpenCode / Goose).  
Probe helper: `diagnoseAcpInstall` in `packages/services/src/agent-adapters/acp/acpProfile.ts`.

## What tip already pins in code (inventory, not a product pin)

| Harness id | Executable on `PATH` | Args | Profile |
| --- | --- | --- | --- |
| `opencode` | `opencode` | `["acp"]` | `acp/agents/opencode.ts` |
| `goose` | `goose` | `["acp"]` | `acp/agents/goose.ts` |

There is **no** Host-enforced minimum CLI version yet. Until a later knife pins one, every diagnosis run must **record the observed version string** so the run is reproducible. Do not invent a pin in product code from this draft.

## Reproduce the install probe (shell)

Run in the **same** environment the Host/target would use (same user, same `PATH`, same container/SSH target). Prefer an isolated `HOME` when testing so global agent configs are not required for a binary-presence check.

```bash
# 1) Resolve which binary PATH would launch
command -v opencode || echo "opencode: NOT ON PATH"
command -v goose || echo "goose: NOT ON PATH"

# 2) Record version text (exact stdout/stderr; keep both if split)
opencode --version 2>&1 || true
goose --version 2>&1 || true

# 3) Confirm the ACP entrypoint exists (does not certify session caps)
opencode acp --help 2>&1 | head -n 40 || true
goose acp --help 2>&1 | head -n 40 || true
```

Map shell results to `diagnoseAcpInstall`:

| Shell observation | `executableFound` | Expected `install.support` | Typical `reason` / constraints |
| --- | --- | --- | --- |
| `command -v` empty | `false` | `unsupported` | `"<name> was not found"` |
| Binary on PATH; optional `versionText` captured | `true` | `supported` | `constraints.executableName` + `args` (+ `versionText` if supplied) |

Honesty lock (do not skip when diagnosing): install `supported` **must not** be read as text/tools/resume/host-managed support. That boundary is I2 / `#65`; this I1 note only gets the binary + version on record.

## Failure → what to read

1. **Not on PATH**  
   - Symptom: `command -v` empty; Host/adapter surfaces install `unsupported` with `"… was not found"`.  
   - Check: target PATH vs interactive shell PATH (desktop apps often get a thinner PATH); whether the binary lives only under a user npm/mise prefix not exported to the Host process.  
   - Fix for diag: install/link the CLI onto the **Host process PATH**, or document an explicit absolute path for a later production wiring knife (not done here).

2. **On PATH but wrong / broken binary**  
   - Symptom: `command -v` hits a stub/wrapper; `--version` fails or prints unrelated tool output.  
   - Record: full `--version` stdout/stderr and `ls -l "$(command -v …)"` (symlink target).  
   - Treat as install failure until version text matches the expected product CLI.

3. **Version churn after upgrade**  
   - Symptom: previously recorded `versionText` no longer matches.  
   - Action: re-run the three probe commands, append a new dated line to the local diagnosis log (below). Do **not** silently assume ACP semantics are unchanged — protocol stability is I3 / LIVE-CERT, not I1.

4. **Where Host-side evidence lives (when a session was attempted)**  
   - SessionHost journal under the configured journal root (events such as `session.error`, `turn.finished`).  
   - Adapter/process stderr from the ACP child (stdio transport): capture when launching `opencode acp` / `goose acp` manually for diag.  
   - Unit evidence only (not install proof): `acpOpenCodeGooseHonesty.test.ts`, `openCodeAcpSessionHost.integration.test.ts` (fake-transport).

## Local diagnosis log template (fill per machine)

```text
date:
target: local | ssh:<id>
PATH_excerpt: (command -v opencode; command -v goose; echo "$PATH")
opencode_version:
goose_version:
opencode_acp_help_ok: yes|no
goose_acp_help_ok: yes|no
diagnoseAcpInstall_opencode: unsupported|supported (+ versionText)
diagnoseAcpInstall_goose: unsupported|supported (+ versionText)
notes: (symlink, mise/npm prefix, Host vs shell PATH mismatch, …)
```

## Explicit non-goals (keep other knives clear)

- Do not flip lazy Host defaults or register opt-in factories in `lazyTargetService`.
- Do not claim LIVE-CERT from PATH/`--version` alone (L1 still needs a real ACP child create→send).
- Do not expand this file into I2–I4 or tip-SHA ledger rewrites in the same change.
