# claude-header-control — early interface (base 12d86b6)

**No product API, profile enablement, Gateway or Model change.** The only new typed boundary is the isolated native fake-endpoint test observation (not exported):

```ts
type NativeHeaderProbe = {
  beta: string[]; // parsed from raw native HTTP anthropic-beta, NOT from Gateway
  thinkingType?: string;
  hasDeferredToolShape: boolean;
  hasContextManagement: boolean;
  probeHeader?: string;
  requests: number;
  error?: string;
};
```

The official [Claude Code environment docs](https://code.claude.com/docs/en/env-vars) describe `ANTHROPIC_CUSTOM_HEADERS` as **adding** headers, not overriding/removing an internally produced beta; require Claude Code >=2.1.227. They describe `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1` as removing beta headers/schema fields and disabling tool search. In SDK 0.3.263 bundled `sdk.mjs`, the custom env is parsed into default headers and `buildHeaders` merges per-request headers after defaults. Raw native wire is authoritative: pinned CLI 2.1.263 with beta-disabling flag still emitted `claude-code-20250219`, `effort-2025-11-24`, `interleaved-thinking-2025-05-14` in unset, distinct-header and explicit-empty-beta modes; distinct custom header *did* arrive. Disabled thinking/no context management/no deferred tool shapes observed. This is a negative result. Gateway `unsupported_beta` remains; do not strip or infer harmlessness. No two-turn Gateway proof because prerequisite zero-beta native request failed.

Spec: `docs/agent-host/CLAUDE-TRANSPORT.md`; test and disposable local endpoint: `packages/services/test/claudeNativeHeaderControl.test.ts`, `packages/services/test/fixtures/probeClaudeNativeHeaders.mjs`. Follow-up SHA (interface/spec commit): recorded below after commit.
