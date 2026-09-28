# Claude Code structured control and Messages ingress

Status: bounded experimental slice for the locally available **Claude Code CLI 2.1.263**. The adapter uses the pinned CLI's documented `-p --input-format stream-json --output-format stream-json` protocol. It does not parse terminal rendering. No npm Agent SDK is bundled because the versioned CLI stream is the chosen structured control interface. This is not a live Provider certification, a default production registration, or completion of P5.

## Ownership and event order

- `SessionHost` remains the only owner of admission, idempotency, accepted commands, Host turn IDs/runtime epochs, canonical event sequence and persisted history. `prepareTurn` consumes the already captured `PreparedHostBinding` before journal acceptance; `send` never recaptures a model or resubmits a prompt during attach.
- One Claude adapter runtime owns one CLI process, one private profile, one opaque native `session_id`, one target-local Messages Gateway grant, one active turn, and its exact pending hook requests. `attach` resumes only that ID and waits for new Host input; it does not resend the accepted prompt.
- Model Gateway owns route authorization, the immutable `@zcode/contracts` Model, request/output budgets, cancellation, and Host-turn lease. Claude Code owns its agent loop, native tools, transcript/context and tool results.
- A target-local HTTP `PreToolUse` hook waits for the Host decision before any tool executes. It correlates the callback's native `tool_use_id` to the active Host turn, runtime epoch and interaction ID. Missing, repeated, stale or duplicate decisions fail closed. A process exit after a Host-accepted prompt without a structured terminal event is `unknown` and is never replayed automatically.

```text
SessionHost captures catalog + Model -> prepare Claude route/grant/profile and lease
  -> journal accepts commandId + non-secret binding fact -> writes one stream-json user item
  -> Claude structured stdout -> loopback POST /v1/messages -> grant/budget admission
  -> frozen Model.streamText(AbortSignal) -> Anthropic SSE -> Claude's own tool/context loop
  -> PreToolUse HTTP callback -> Host interaction.requested -> exact allow/deny response
  -> Claude executes only after allow, streams tool result and terminal result
  -> adapter emits turn/message/tool/usage events -> Host journal -> lease ends
```

## Pinned ingress profile

The first compatibility row uses the installed `claude` executable reporting `2.1.263`; discovery verifies that exact version in a private HOME/profile. Each session gets a mode-0700 `CLAUDE_CONFIG_DIR`, no user/project/local setting sources, an explicit generated settings file, empty strict MCP config, no plugin directories and an environment allowlist. The child receives no Provider credentials. A session capability is supplied to the CLI through `apiKeyHelper`, not an inherited API-key environment variable. `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` removes credentials from tool and hook subprocess environments. The adapter also sets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`, `DISABLE_PROMPT_CACHING=1`, `MAX_THINKING_TOKENS=0`, `CLAUDE_CODE_DISABLE_THINKING=1`, and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1`; the pinned loopback probe confirms no `thinking`, `context_management`, or `cache_control` fields after these switches. The CLI still sends a bounded observed beta-header allowlist and `output_config.effort`, which must agree with the prepared Model's reasoning option.

The observed model request is `POST /v1/messages?beta=true`, with `anthropic-version: 2023-06-01`, `x-api-key`, a model alias, `stream: true`, `max_tokens`, text-only system/messages, and standard `{name,description,input_schema}` tools. The only observed auxiliary call was `HEAD /api/hello`; it performs no Model work. No `count_tokens` or models request was observed, so these routes are unsupported. The server accepts the route/model only from the grant and rejects client upstream URLs, model substitution, unknown beta headers, unknown body fields, provider routing, developer-role messages, cache controls, images, non-text tool results, custom tool variants, thinking/signatures and output formats. Top-level Anthropic `system` maps only to `ModelRequest.systemInstructions`; ordered Anthropic system messages stay `role: "system"` in `ModelRequest.messages`. The adapter does not flatten developer messages into system instructions.

Messages streaming usage must come from the bound Model stream, never a tokenizer estimate or Anthropic price estimate. The stream encoder requires provider-reported input-token usage at start and terminal output usage; a Model without those facts cannot satisfy the Messages stream contract. Terminal usage replaces prior partial usage snapshots. Unsupported Model reasoning blocks are rejected before they can become unsigned Anthropic thinking blocks.

## Failure and security boundaries

- Grants are protocol-bound (`openai-responses` or `anthropic-messages`), target/session/model-alias bound, short lived and single-use token scoped. Messages accepts the observed `x-api-key` header only; the HTTP capability is not a Provider API key. Cross-protocol, wrong model, missing auth, unknown beta, invalid body, exceeded budget, stale lease and unsupported features are rejected before `Model.streamText`.
- The target process renews only its active Host-turn lease and ends that exact lease on terminal completion. Catalog changes cannot replace a prepared/active turn's Model; the next idle Host turn captures and prepares the new binding. No UI heartbeat is required.
- Cancel aborts the current CLI owner and propagates client disconnect to `Model.streamText`. Renderer detach does not terminate the CLI. Explicit terminate stops only this Host session. A crash with an accepted in-flight prompt is unknown.
- Host tool IDs are derived from the native IDs plus Host turn/epoch. Approval state never trusts an unscoped native ID. Repeated or late answers cannot mutate a later turn.
- Native Claude account/subscription authentication is unsupported. No personal settings, keychain, OAuth state, plugins or MCP servers are read or reused. Auxiliary model routes (title, compaction, subagents), `/v1/messages/count_tokens`, and `/v1/models` remain unsupported until an exact route is observed and bound through the same turn Model.

## Acceptance scenarios

1. Decoder/encoder tests preserve system/user/assistant text, ordered tool-call batches and paired text tool results; reject unknown fields, developer flattening, images, cache/thinking/signature, beta and model/output-control mismatches before generation; verify finish reasons, SSE usage replacement, model errors, cancellation and input/output budgets.
2. HTTP tests cover route/auth/protocol isolation, `x-api-key`, alias binding, body limit, concurrent/request/output limits, lease renewal/end, disconnect abort, no-call-on-rejection, `HEAD /api/hello`, and unsupported auxiliary routes.
3. A real 2.1.263 CLI process flows through the actual HarnessAdapter, SessionHost, Messages Gateway and only a loopback FakeModel. It covers text, multiple tools and paired results, two isolated sessions, PreToolUse allow and deny, cancel, opaque native ID resume without duplicate prompt, unknown process exit, stale/duplicate approval IDs, long-turn lease renewal and idle next-turn rebinding. Tool approval checks filesystem effects, not only callback counts.
4. Egress tracing confirms the only permitted network destination is the loopback Gateway and reports the actual health/auxiliary endpoints. Runtime profiles/processes are removed only after normal child exit.

No real Provider/API request, account secret, Claude subscription or SSH target is permitted. A FakeModel pass is exact local protocol evidence only; other selections stay experimental or unsupported and P5 remains incomplete.
