# Claude Code v2 adapter — bounded, not certified

Owner: target-local ClaudeHarnessAdapter owns ephemeral per-session process/turn, SDK native ID and approval table; Host alone owns command admission, immutable BindingV2, journal and frozen turn route; Model Gateway owns the per-turn token, frozen Model executor and revocation. No account route or native ZCode executor fallback. `claude-code` manifest is trusted code, not repository input.

```text
Host create -> adapter canonical target cwd -> official SDK sessionId UUID allocated -> immutable BindingV2 persisted
Host freeze turn -> adapter prepareTurn(plan, epoch, turn) -> Gateway per-turn token -> SDK query with sessionId (first) or resume (only after successful persisted native result)
SDK init checks binding ID/version -> PreToolUse hook -> Host interaction -> same epoch+turn+interaction allow/deny
SDK result AND zero exit -> persist native committed-turn receipt -> turn.finished -> revoke token
cancel -> abort SDK -> revoke token -> late decision denied; attach after uncertain execution refuses replay
```

Each query has separate isolated child environment, explicit empty settingsSources and mandatory PreToolUse, never bare mode. Requested/effective Model selection must be identical and mapped to a trusted native backend model ID; Gateway issued token is bound to that effective route and captured executor (no process-env retargeting). Tokens and native model names are separate fields. Distinct session directories isolate history; no sharing of approvals or tokens. Resume needs both a completed native receipt and same native ID; a crash before receipt is execution-unknown, never replay original prompt. A zero-event fresh binding may start using the preallocated `sessionId`; `attach` with a nonzero journal and no native receipt rejects. Unknown/late events fail closed.

**Capability boundary:** CLI 2.1.263 still sends `claude-code-20250219` with `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`; native Messages Gateway rejects it. `hostManagedSupport` remains unsupported and reports this exact reason even if isolated fake endpoint proves mechanics. No production turn accepted by Host until wire semantics and target profile independently certified; no fabricated native Gateway claim. Synthetic/fake upstream is not provider certification.

Acceptance: pinned SDK 0.3.263 supplied `sessionId` agrees with first native init; second native process uses `resume` only after successful native receipt; identity mismatches, stale approval, cancelled/uncertain first turn, model changes and multi-session isolation fail closed. Actual fixed CLI fake upstream demonstrates two adapter turns (three Messages requests), isolated per-turn mock leases, native supplied ID + verified fresh-process resume, denied Edit with unchanged file; no paid calls. No silent replay on restart. Failed/inflight turn keeps a durable intent marker; even a previous successful receipt does not authorize retry after unknown execution. A valid prior receipt alone cannot certify that native history survives external deletion; native resume failure remains execution-unknown. No direct UI/service composition modifications: public `@zcode/services/agent-host/claude` exposes typed factory hooks and trusted manifest for service owner to register.
