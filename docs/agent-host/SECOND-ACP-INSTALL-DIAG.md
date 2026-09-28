# Second ACP — install / capability diagnosis drafts (I1–I4)

**Scope:** I1–I4 install-diag drafts + **L1–L4 LIVE-CERT procedure stubs** (docs only; no real ACP child / no lazy flip in this knife).  
**Not in this note:** Executed L1–L4 evidence, tip-SHA ledger sync (ex6), lazy default flip, production wiring.  
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

---

## L1 — live ACP subprocess probe (docs stub only)

**Tip already has:** SessionHost **fake-transport** create/send + late prompt + disconnect fault fence (#75/#80/#83/#85/#90). That is **not** L1.

**This knife:** write the procedure and evidence template only. **Do not** launch `opencode acp` / `goose acp`, open a real transport, or claim LIVE-CERT from this document alone.

### Preconditions (before any future real run)

1. Complete I1 on the **same** target (PATH + recorded `versionText`).
2. Confirm I2 reading: install `supported` will not be treated as session caps.
3. Plan to fill I3 matrix from the **first** real `initialize` result.
4. Isolated data only: temp `HOME` / config dir, temp worktree, temp SessionHost journal root.
5. Opt-in registry only (`createExperimentalRegistryOpenCodeAcpHarness` / `createExperimentalRegistryGooseAcpHarness` with a **real** `openTransport`). **Never** register into `lazyTargetService` for the probe.
6. No Provider/API credentials in the child env unless a later authorized live knife says so; record credential URLs as redacted placeholders only.

### Intended sequence (future real run — not executed here)

```text
1. I1 probes → record CLI versionText
2. Spawn `opencode acp` OR `goose acp` over stdio (one agent per run)
3. initialize → classify with I3 table (abort if experimental)
4. session/new (or equivalent create) → session/prompt with a tiny fixed text
5. Observe Host journal: turn.started, text.delta (if any), turn.finished
6. Close transport cleanly; do not attempt resume in L1 (that is L2)
```

### Evidence template (leave blank until a real run)

```text
date:
target: local | ssh:<id>
harness_id: opencode | goose
cli_versionText:
command: <executable> acp
isolated_HOME:
isolated_worktree:
journal_root:
initialize_protocol_version:
initialize_stability: stable | experimental
create_ok: yes|no|not-run
send_ok: yes|no|not-run
journal_event_kinds: (list)
child_stderr_summary: (no secrets)
credential_urls: none | redacted
lazyTargetService_unchanged: yes
result: not-run (docs stub) | pass | fail | aborted-experimental
```

### Pass / fail bar (for when a later knife executes)

| Outcome | Means |
| --- | --- |
| **pass** | Real child completed create→send; journal shows a finished turn; CLI version + sanitized initialize recorded; lazy defaults untouched |
| **fail** | Stable negotiate but create/send/journal incomplete; attach stderr + journal excerpt |
| **aborted-experimental** | I3 experimental — correctly refused create; still counts as a useful probe, not LIVE-CERT pass |
| **not-run** | This docs stub only — **current state of this knife** |

---

## L2 — resume / read-only history (docs stub)

**Tip already has:** profiles do **not** hardcode `session/load|resume`; honesty does not open transport for install (#65); resume comes only from **this** `initialize` (I3 / `COMPATIBILITY.md`).

**This stub:** procedure for a future live (or stronger fake-transport) proof. Not executed here. Fake-transport SessionHost resume-after-disconnect remains a separate optional knife.

### When resume is allowed (after a real L1-stable initialize)

1. Confirm I3 row: `stability=stable` and (`loadSession` **or** `resumeSession`).
2. Create→send once (L1 path) and record `backendSessionId` / Host session id from journal.
3. Close transport cleanly.
4. Re-open with opt-in factory + real (or test) transport; call only the **negotiated** method (`session/load` vs `session/resume`).
5. Assert Host journal: history visible; execution continues only if negotiation said so.
6. If negotiation had **neither** load nor resume: skip step 4–5 execution; prove **history-only** from Host journal without sending load/resume/new/prompt for resume.

### Evidence template (blank until run)

```text
date:
harness_id: opencode | goose
initialize_stability:
loadSession: yes|no
resumeSession: yes|no
resume_attempted: yes|no|n/a-history-only
method_used: session/load | session/resume | none
journal_history_readable: yes|no
execution_continued: yes|no|n/a
lazyTargetService_unchanged: yes
result: not-run | pass-resume | pass-history-only | fail
```

---

## L3 — second same-protocol Agent adds profile only (docs stub)

**Tip already has:** OpenCode / Goose inventory profiles share `acp-session-machine/1`; opt-in factories (#75); coexistence rules with Devin print vs ACP exclusivity tests.

**Still missing:** product-path proof that admitting a second ACP Agent does **not** fork `AcpSessionMachine` or add brand branches in Host/UI.

### Intended proof outline (future)

1. Baseline: machine + Host tests green with **one** opt-in ACP id registered.
2. Register **second** id via the same `createAcpHarness` / profile pattern only (no machine edits).
3. Diff gate: `AcpSessionMachine` / shared ACP protocol files unchanged in the admission PR (or only shared bugfixes pre-agreed).
4. Run SessionHost fake-transport (or later live) create→send for **both** ids.
5. Record: no `lazyTargetService` registration; no Picker/UI brand fork required for this cert row.

### Evidence template

```text
date:
agents_under_test: opencode, goose
shared_machine: acp-session-machine/1
machine_diff_in_admission: none | describe
both_ids_create_send_ok: not-run | yes | no
product_picker_path: not-in-scope-for-stub | exercised
lazyTargetService_unchanged: yes
result: not-run | pass | fail
```

---

## L4 — Host default must stay opt-in (docs stub)

**Tip already has:** contract tests that `lazyTargetService` does **not** register OpenCode/Goose ACP factories; Devin lazy default remains print-mode.

**This stub:** live-cert / release checklist so a future L1–L3 run **cannot** “accidentally” promote opt-in to lazy default.

### Mandatory assertions (every live or integration cert run)

1. Before/after the run: source or contract test still proves OpenCode/Goose **absent** from lazy Host composition.
2. Probe registry is constructed **explicitly** (opt-in factories / `enabledIds`), never by flipping lazy defaults.
3. PR / patch touching live cert must **not** include `lazyTargetService` registration of `opencode` / `goose`.
4. If a future product decision promotes ACP to default, that is a **separate** Planner-assigned knife with its own acceptance — not smuggled under L1–L3.

### Evidence template

```text
date:
lazy_opencode_registered: no
lazy_goose_registered: no
contract_test: lazyTargetService does not register OpenCode or Goose ACP opt-in factories
probe_registration_path: opt-in-only
result: not-run | pass | fail
```

### Explicit non-goals

- No real ACP process, network Provider call, or LIVE-CERT **pass** claim in this change.  
- No execution of L1–L4 runs; stubs + templates only.  
- No tip-SHA mass rewrite (ex6).  
- No UI / CLI / UsageRemaining / productPresentation / sidebar badge edits.  
- No lazy / production default flip.

