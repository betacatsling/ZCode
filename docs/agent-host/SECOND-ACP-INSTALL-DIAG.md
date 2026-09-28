# Second ACP — install / capability diagnosis drafts (I1–I4)

**Scope:** I1–I4 install-diag drafts for OpenCode / Goose (second ACP).  
**Not in this note:** L1–L4 live cert, tip-SHA ledger sync (ex6), lazy default flip, production wiring.  
**Hard rules:** docs-only; do **not** register OpenCode/Goose in `lazyTargetService`.

Checklist: `IMPLEMENTATION.md` → P6 → install-diag / LIVE-CERT.  
Inventory: `packages/services/src/agent-adapters/acp/COMPATIBILITY.md`.  
Code: `diagnoseAcpInstall` (`acpProfile.ts`), `negotiateAcp*` / `acpHarnessCapabilities` (`acpProtocol.ts`, `acpCapabilities.ts`).

---

## I1 — CLI pin + PATH

### What tip already pins in code (inventory, not a product pin)

| Harness id | Executable on `PATH` | Args | Profile |
| --- | --- | --- | --- |
| `opencode` | `opencode` | `["acp"]` | `acp/agents/opencode.ts` |
| `goose` | `goose` | `["acp"]` | `acp/agents/goose.ts` |

There is **no** Host-enforced minimum CLI version yet. Until a later knife pins one, every diagnosis run must **record the observed version string** so the run is reproducible. Do not invent a pin in product code from this draft.

### Reproduce the install probe (shell)

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

### Failure → what to read (I1)

1. **Not on PATH** — Host/adapter surfaces install `unsupported` with `"… was not found"`. Compare Host process PATH vs interactive shell; check mise/npm user prefixes.  
2. **Wrong / broken binary** — Record full `--version` and `ls -l "$(command -v …)"`.  
3. **Version churn after upgrade** — Re-run probes; append a dated log line. Protocol stability is I3 / LIVE-CERT, not I1.  
4. **Host-side evidence** — SessionHost journal (`session.error`, `turn.finished`); ACP child stderr; unit-only: `acpOpenCodeGooseHonesty.test.ts`, `openCodeAcpSessionHost.integration.test.ts` (fake-transport ≠ install proof).

### Local diagnosis log template (I1 fields)

```text
date:
target: local | ssh:<id>
PATH_excerpt:
opencode_version:
goose_version:
opencode_acp_help_ok: yes|no
goose_acp_help_ok: yes|no
diagnoseAcpInstall_opencode: unsupported|supported (+ versionText)
diagnoseAcpInstall_goose: unsupported|supported (+ versionText)
notes:
```

---

## I2 — install / probe ≠ session capability (ops stub)

**Tip already has:** honesty `#65` — install probe `supported` does **not** upgrade text / tools / resume; `hostManagedSupport` stays `unsupported` without opening transport.

**Still missing for product:** a short ops reading of probe outputs. This stub is that reading guide.

### How to read reports (order matters)

1. **`install` (`diagnoseAcpInstall`)** — binary presence (+ optional `versionText`) only.  
2. **`acpProbeReport(negotiation)`** — after a real `initialize`: experimental if unstable protocol; `unsupported` if auth methods were advertised (adapter does not submit credentials); else `supported` means “may attempt session,” **not** “session caps certified.”  
3. **`acpHarnessCapabilities(negotiation)`** — text/tools/approvals/cancel follow **session** negotiation (`sessionReport`), not install.  
4. **`resumeExecution`** — only from `loadSession` / `resumeSession` on **this** initialize (see I3). Never from “binary found” or profile name.  
5. **`hostManagedModel`** — always `unsupported` for these long-tail ACP agents in tip code.

### Forbidden interpretations

| Observation | Must **not** conclude |
| --- | --- |
| `install.support === "supported"` | text/tools/resume/host-managed are supported |
| Profile id is `opencode` / `goose` | `session/load` or `session/resume` is available |
| Fake-transport SessionHost tests green | live CLI install or LIVE-CERT |
| Honesty unit green | production admission / lazy registration |

### Ops checklist (I2)

```text
install_supported: yes|no
negotiation_seen: yes|no
acpProbeReport:
text/tools/resume_from_capabilities: (copy CapabilityReport.support)
opened_transport_for_probe_only: yes|no   # must stay no for install-only diag
assert_install_did_not_upgrade_session_caps: yes|no
```

Evidence pointer: `packages/services/test/acpOpenCodeGooseHonesty.test.ts`.

---

## I3 — `initialize` version / capability matrix (stub)

Mirror of `COMPATIBILITY.md` for ops + product triage. Fill observed cells during live runs; do not invent CLI pins here.

### Protocol version → Host stance

| Negotiated protocol | `stability` | Create new session? | Resume / load? | viewHistory |
| --- | --- | --- | --- | --- |
| version **1**, and `loadSession` **or** `sessionCapabilities.resume` | `stable` | yes (harness-managed binding) | only the negotiated method (`session/load` or `session/resume`) | Host events |
| version **1**, neither load nor resume | `stable` | yes | `unsupported` — do **not** send load/resume/new/prompt for resume | still view Host history |
| version **2** | `experimental` | **no** | no session methods | do not depend on Agent |
| unknown version | `experimental` | **no** | no session methods | do not depend on Agent |

Client may offer version 2 in `initialize`; if peer settles on 1, operate on the **v1 negotiated** row.

### Capability matrix stub (fill per observed CLI version)

| Field | Source | OpenCode (observed) | Goose (observed) |
| --- | --- | --- | --- |
| CLI `versionText` | I1 `--version` | _TBD_ | _TBD_ |
| protocol version from `initialize` result | negotiation | _TBD_ | _TBD_ |
| `stability` / `stabilityReason` | `acpProtocol` | _TBD_ | _TBD_ |
| `loadSession` | capabilities | _TBD_ | _TBD_ |
| `resumeSession` (`sessionCapabilities.resume`) | capabilities | _TBD_ | _TBD_ |
| `authMethodIds` (record only; never submit) | `authMethods` | _TBD_ | _TBD_ |
| `resumeExecution.support` | `acpHarnessCapabilities` | _TBD_ | _TBD_ |
| `text` / `tools` support | session report | _TBD_ | _TBD_ |
| `hostManagedModel` | adapter constant | `unsupported` | `unsupported` |

### Triage entry (unknown / experimental)

1. Capture raw `initialize` result (sanitize secrets).  
2. Classify with the version table above.  
3. If `experimental`: do **not** create or resume; keep Host history readable; escalate as protocol pin / upgrade decision (I4), not as “retry install.”  
4. If `stable` but resume unsupported: allow new session only; history is Host-journal read-only for execution.

---

## I4 — fault / upgrade / rollback handbook (stub)

**Tip already has:** adapter does **not** run `opencode auth login` / `goose acp` credential submission / brand login flows (`COMPATIBILITY.md`).

### Symptom → first action

| Symptom | First action | Do **not** |
| --- | --- | --- |
| Binary missing / install `unsupported` | I1 PATH + version probes; fix PATH or install CLI | Flip lazy Host defaults; invent absolute paths in prod from this draft alone |
| Auth methods advertised → probe `unsupported` | Record `methodId`s; keep adapter no-submit stance; user authenticates **outside** Host | Run `opencode auth login` / inject credentials via Host |
| Protocol `experimental` (v2 / unknown) | Refuse create/resume; journal reason; plan CLI downgrade or wait for stable contract | Silent migrate old `backendSessionId` onto new protocol |
| Mid-turn transport fault / disconnect | Expect journal `session.error` + `turn.finished` (fake-transport #90); re-open only after I3-stable negotiation | Treat disconnect as successful resume |
| Want to remove second ACP from a registry | Unregister harness id from **opt-in** registry only; Host history remains readable | Touch `lazyTargetService` defaults |

### Upgrade / rollback (draft)

1. **Before upgrade:** record I1 `versionText` + I3 matrix row for current CLI.  
2. **After upgrade:** re-run I1 + a single `initialize` (isolated data); fill a new I3 row.  
3. **If stability left `stable`:** keep using new session creates; resume only if renegotiated.  
4. **If stability became `experimental`:** rollback CLI pin or leave harness unregistered; do not create sessions.  
5. **Rollback registration:** remove opt-in factory registration for that id; do not delete Host journals.

### Explicit non-goals

- No L1–L4 LIVE-CERT claims from these stubs.  
- No tip-SHA mass rewrite in this change (ex6).  
- No UI / CLI / UsageRemaining / productPresentation edits.

