# Pi target-local worker protocol (implementation spec)

Pinned Pi SDK 0.87.1 runs in a Node worker on the execution target, not in renderer/Electron main. Native Pi session files, settings and extension discovery are isolated under a host-owned per-session directory; no global Pi config is edited or implicitly loaded. A process-local provider registered via Pi ModelRuntime forwards each Pi model request through correlation-ID IPC, not directly to an upstream URL. `SessionHost` binds one catalog snapshot and Model before each send is accepted; the adapter routes every Model request in that active Host turn to that frozen Model and clears the reference when the turn settles. A catalog update can therefore affect the next turn without changing a running turn or replacing Pi's native history. No Provider API key is passed to Pi. Per-request abort propagates across the IPC boundary.

A `tool_call` SDK hook is the authoritative approval gate. Only declared read may run unattended; write/edit/bash require a matching allow decision for the exact toolCallId and turnId, otherwise are blocked before execution. An unknown tool fails closed. The hook publishes an interaction only after it has installed the pending waiter. `tool_execution_start` publishes the tool row; `tool_execution_end` publishes the result; `message_update` and `message_end` publish matching message IDs (the terminal replaces delta). `agent_end` is not inferred from stdout. Repeated approvals and stale turn/epoch are rejected in target SessionHost.

Packaged target runtimes must carry the worker entrypoint **and** its transitive Pi SDK dependencies: desktop `out/host/piWorker.js`, standalone server `runtime/piWorker.js`, with the worker URL resolved relative to its owner bundle and a packaged smoke test that creates a real Pi worker. Bundlers must not inline Pi's CJS-backed SDK into an ESM worker where `require("child_process")` fails, nor prepend a banner that redeclares `__filename` in the worker. The smoke test must import and initialize the _built_ worker, not only check the file exists. Missing assets reject session creation before claiming Pi availability. Worker crash after an accepted send is `execution-unknown`, never resend. Reattach may load Pi's native session file for history or a new turn only after explicit reconciliation; canonical V4 history remains the host journal. `detach` never terminates the worker. Tests first use fake model streams and isolated session directories; actual local and Linux SSH targets with two Providers require separate certification.

## Live model bridge certification

The live route uses the same `ProviderRegistry` selection and
`AiSdkModelAdapter` executor as native ZCode. `PiHarnessAdapter` only hosts the
Pi SDK loop; it never receives the upstream key or endpoint. The bounded live
fixture records requested/effective Provider and model IDs, Pi SDK `0.87.1`,
per-request usage and estimated cost. StepFun `step-3.5-flash` uses explicit
`reasoningLevel=low` under the small token/request cap in
`LIVE-CERTIFICATION.md`. AxonHub `deepseek-v4-flash` was also run once per
target with `reasoningLevel=off`; its proxy price is unknown, so DeepSeek
origin pricing is not used as an AxonHub charge.

Some Provider APIs cannot disable reasoning for a model even when the host
selection is `off`. The model bridge maps that selection to the provider's
lowest supported effort and preserves returned reasoning as a structured Pi
thinking block; it never silently drops the field or treats it as a tool side
effect. The host's canonical text/tool projection can still omit thinking from
user-facing rows while the Pi native response retains the structured block.

## Native CLI V4 certification boundary

The native fake route is a separate ownership path from Pi: the fixture starts
the built CLI `app-server --stdio`, injects an isolated Provider Config through
the official registry file schema, and sends V4 `createSession`, `sendText`,
`resolveInteraction` and `stop` commands through `ZCodeProtocolClient`. Its
loopback fake gateway is only a deterministic Provider substitute; it does not
exercise Pi, `SessionHost` or the external conversation bridge. The fixture
asserts that native `CommandInbox` admission, approval accept/decline, tool
side effects, interrupted history and `rowsRange` all settle before cleanup.
Real Provider native calls remain a separate matrix from the fake route and
must record their own requested/effective model selection and usage.
