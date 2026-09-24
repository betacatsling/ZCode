# CodexHost reference assessment (2026-09-24)

Reviewed `BytePioneer-AI/codex-host` at commit `d9fa7aa26474127bb80cbf086cd49503f7cc4ccf` (separate read-only checkout). **License: LGPL-3.0-only** (`LICENSE`, root `package.json`), whereas this ZCode tree carries Apache-2.0. Do not copy source files, vendor its packages, or use its adapters as dependencies without a legal/compliance review and required notices/source obligations. This note records architecture ideas, not imported code.

Useful independent design references:

- `packages/adapters/claude-code/src/sdk-transport.ts`, `tool-lifecycle.ts`: structured Agent SDK stream, native session resume, tool lifecycle, cancellation and usage. Its `canUseTool` callback plus `settingSources:["user"]` is **not** evidence of a universal mandatory approval gate; ZCode must verify a PreToolUse/equivalent enforcement point and isolate user settings.
- `packages/mapping-store/src/mapping-store.ts`: host/native ID mapping, process identity and single-writer fencing. Compare against ZCode's independent target-local manifest, command and event journals; do not reuse Codex Desktop's thread IDs as ZCode host IDs.
- `packages/protocol-core/src/codex-approval.ts`, `codex-ui-projector.ts`: map backend interactions and lifecycle to one UI protocol. ZCode must project to *its own* V4 subset and reject unsupported commands, not adopt Codex Desktop's wire format.
- `packages/host-runtime/src/remote-host-lifecycle.ts`: classify remote runtime as running/conflict/unknown before takeover. Reuse this invariant for Linux SSH supervisor without treating a transient SSH stdio connection as a durable host.

Architectural inversion: CodexHost embeds **Pi/Claude inside Codex Desktop** using a Codex app-server shim. ZCode's plan hosts **Pi/Codex/Claude inside ZCode** and routes certified model calls through ZCode's Provider Registry/Model executor. Therefore its Codex Desktop shim, renderer injection, account import and model labels cannot replace ZCode's Codex app-server *client*, Model Gateway (Responses/Messages), V4 session facade or two-Provider live certification. Any later implementation should be original code driven by pinned official protocol fixtures and target-local tests.
