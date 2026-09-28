# Devin Host adapter protocol (Wave 2 / 2.5)

Sources: [Devin CLI Quickstart](https://docs.devin.ai/cli), [Essential Commands](https://docs.devin.ai/cli/essential-commands), [Commands & Flags](https://docs.devin.ai/cli/reference/commands).

## Landed behavior (what works today)

| Piece | Status | Evidence |
| --- | --- | --- |
| Host directory / lazy register | Done | `id: "devin"`, `adapterVersion: "0.1.0"`; `createExperimentalRegistryDevinHarness` in `lazyTargetService` |
| CLI probe | Done | Isolated `--version`; missing CLI → `unsupported` with readable reason |
| SessionHost create + one send | Done | harness-managed admission; print-mode turn events in Host journal |
| Tests | Done | `devinHarnessAdmission.test.ts`, `devinSessionHost.integration.test.ts` (fake CLI) |

**Session path is `-p` only.** Each `send` spawns a short-lived process and exits; there is no persistent REPL/ACP child.

## What Devin CLI exposes vs what Host uses

| Surface | Command | Host use |
| --- | --- | --- |
| Interactive REPL | `devin` / `devin -- <prompt>` | Not used (TTY UI). |
| Print / single-turn | `devin -p [PROMPT]` or `devin -p -- <prompt>` | **Only wired session path.** Stdout = assistant text. |
| Resume | `-c` / `-r <id>` | **Not wired** — no native session id stored on `BackendBinding`. |
| ACP server | `devin acp` | **Not wired** (future JSON-RPC). |
| Auth / models | `devin auth …` | Harness-managed; Host does **not** inject Provider Registry keys. |

Non-interactive `-p` cannot show the workspace trust prompt → Host always passes `--respect-workspace-trust false`.

## Host API mapping (implemented)

| Host API | Behavior |
| --- | --- |
| `probe` | Resolve `devin` (PATH or `executablePath`); isolated version check → `supported` + `cliVersion` constraint, else `unsupported`. |
| `harnessManagedSupport` | Same as probe (required for SessionHost admission). |
| `hostManagedSupport` | Always `unsupported` (no Host Provider binding). |
| `create` | Resolve CLI, allocate `BackendBinding` (`backendSessionId: devin-print-…`, new `runtimeEpoch`). No long-lived child. |
| `attach` | Rehydrate binding in memory; does not restart a process. |
| `send` | One print-mode spawn: `devin -p --respect-workspace-trust false -- <text>`, cwd = worktree. Emit `turn.started` → `text.delta` → `message.finished` → `turn.finished`. Non-zero exit → `session.error` + failed turn. `AgentCommand.send` has no `runtimeEpoch` (do not check it). |
| `cancelTurn` | Kill active print-mode process tree (`runtimeEpoch` required). |
| `resolveInteraction` | Throws — print mode has no Host-mediated approvals. |
| `terminate` / `shutdown` | Drop session; kill any active child. |

`hostManagedRoute` is `"harness-managed"`.

## Capabilities (honest)

- **text / cancelTurn**: `experimental` (print-mode only; no tool stream).
- **tools / approvals / history / resumeExecution / images / modelSwitch**: `unsupported`.
- Probe/`harnessManagedSupport` may be `supported` so SessionHost can admit; that does **not** mean tools or multi-turn resume work.

## Known limitations (`-p` only)

1. **No structured tools/approvals/files** — stdout is opaque text; no `interaction.requested`, no tool events.
2. **No multi-turn native continuity** — each send is a fresh `-p` process; no `-c`/`-r`, no export/ATIF session id capture.
3. **Auth is ambient** — relies on user `devin auth` / env (`WINDSURF_API_KEY` / `DEVIN_API_KEY` if present); Host never mints tokens.
4. **Not a substitute for ACP** — editors should eventually use `devin acp`; Wave 2 deliberately stays on print mode.
5. **Real CLI not required for CI** — admission/SessionHost tests use a fake executable that answers `--version` and `-p`.

## Out of scope (later waves)

- Full `devin acp` JSON-RPC session.
- Capturing native session id for `-r` resume.
- Tool / approval / file-change event translation.
- Cloud (`--cloud`) and SSH session steering.
