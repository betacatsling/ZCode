# claude-repair API handoff

No production cross-module API change. `createClaudeHarness(profile: TrustedClaudeProfile): ClaudeHarnessAdapter` unchanged; `send`, `terminate`, `shutdown`, `subscribe` retain HarnessAdapter signatures. Canonical `message.finished` is the existing shared schema; Claude adapter publishes user prompt at turn start and terminal assistant replacement before `turn.finished(success)`. A test-only optional `TrustedClaudeProfile.writeInflight?: (path: string, contents: string) => Promise<void>` controls the exclusive durable write boundary (default uses `writeFile(..., {flag:'wx',mode:0o600})`). Do not use this hook in production profiles. Shutdown mid-write emits `turn.finished(unknown)` once before detaching; send rejects; no transport launch after lease revocation.

Initial interface/spec commit: `b44b7ea785df079e2ebfa70b6c18e1617cb86673` (base `ffc9564`).
