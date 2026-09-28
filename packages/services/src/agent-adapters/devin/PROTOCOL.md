# Devin Host adapter protocol (Wave 2 / 2.5)

Sources: [Devin CLI Quickstart](https://docs.devin.ai/cli), [Essential Commands](https://docs.devin.ai/cli/essential-commands), [Commands & Flags](https://docs.devin.ai/cli/reference/commands).

## Landed behavior (what works today)

| Piece                          | Status | Evidence                                                                                                                    |
| ------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| Host directory / lazy register | Done   | `id: "devin"`, `adapterVersion: "0.1.0"`; `createExperimentalRegistryDevinHarness` in `lazyTargetService`                   |
| CLI probe                      | Done   | Isolated `--version`; missing CLI → `unsupported` with readable reason                                                      |
| SessionHost create + one send  | Done   | harness-managed admission; print-mode turn events in Host journal                                                           |
| Tests                          | Done   | `devinHarnessAdmission.test.ts`, `devinCapabilitiesHonesty.test.ts`, `devinSessionHost.integration.test.ts` (fake CLI argv) |
| Optional ACP profile           | Done   | `packages/services/src/agent-adapters/acp/agents/devin.ts` (`args: ["acp"]`); covered by `acpHarness.test.ts` + coexistence contract |

**Default Host session path is still `-p` only** (lazy `createDevinHarness`). Each print-mode `send` spawns a short-lived process and exits. Editors that opt into ACP use `createAcpHarness({ profile: devinAcpProfile })` instead — same harness id `devin`, so the two adapters must not both register on one `HarnessRegistry`.

## What Devin CLI exposes vs what Host uses

| Surface             | Command                                       | Host use                                                          |
| ------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Interactive REPL    | `devin` / `devin -- <prompt>`                 | Not used (TTY UI).                                                |
| Print / single-turn | `devin -p [PROMPT]` or `devin -p -- <prompt>` | **Only wired session path.** Stdout = assistant text.             |
| Resume              | `-c` / `-r <id>`                              | **Not wired** — no native session id stored on `BackendBinding`.  |
| ACP server          | `devin acp`                                   | **Optional ACP profile** — `devinAcpProfile` / `createAcpHarness` (stdio JSON-RPC). Host lazy path still print-mode. |
| Auth / models       | `devin auth …`                                | Harness-managed; Host does **not** inject Provider Registry keys. |

Non-interactive `-p` cannot show the workspace trust prompt → Host always passes `--respect-workspace-trust false`.

## Host API mapping (implemented)

| Host API                 | Behavior                                                                                                                                                                                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probe`                  | Resolve `devin` (PATH or `executablePath`); isolated version check → `supported` + `cliVersion` constraint, else `unsupported`. `supported` means the CLI answered `--version`. It does **not** certify tools, approvals, history, resume, images, or model switch.                |
| `harnessManagedSupport`  | Same report as probe (required for SessionHost admission). Admission `supported` is not a full ACP capability set.                                                                                                                                                                 |
| `hostManagedSupport`     | Always `unsupported`, including after a successful probe (no Host Provider binding).                                                                                                                                                                                               |
| `create`                 | Resolve CLI, allocate `BackendBinding` (`backendSessionId: devin-print-…`, new `runtimeEpoch`). No long-lived child.                                                                                                                                                               |
| `attach`                 | Rehydrate binding in memory; does not restart a process.                                                                                                                                                                                                                           |
| `send`                   | One print-mode spawn: `devin -p --respect-workspace-trust false -- <text>`, cwd = worktree. Emit `turn.started` → `text.delta` → `message.finished` → `turn.finished`. Non-zero exit → `session.error` + failed turn. `AgentCommand.send` has no `runtimeEpoch` (do not check it). |
| `cancelTurn`             | Kill active print-mode process tree (`runtimeEpoch` required).                                                                                                                                                                                                                     |
| `resolveInteraction`     | Throws — print mode has no Host-mediated approvals.                                                                                                                                                                                                                                |
| `terminate` / `shutdown` | Drop session; kill any active child.                                                                                                                                                                                                                                               |

`hostManagedRoute` is `"harness-managed"`.

## Capabilities (honest)

`devinHarnessCapabilities()` is the only capability owner. `DevinHarnessAdapter.capabilities()` returns that object unchanged. SessionHost may copy fields into `BindingPlan.capabilities`; it must not upgrade them when probe is `supported`.

| Field             | `support`      | Reason must say                                                         |
| ----------------- | -------------- | ----------------------------------------------------------------------- |
| `text`            | `experimental` | print mode and `-p`; stdout is opaque assistant text, not a tool stream |
| `cancelTurn`      | `experimental` | cancel kills the active print-mode (`-p`) process tree                  |
| `tools`           | `unsupported`  | print mode / `-p`                                                       |
| `approvals`       | `unsupported`  | print mode / `-p`                                                       |
| `history`         | `unsupported`  | print mode / `-p`                                                       |
| `resumeExecution` | `unsupported`  | print mode / `-p` (no `-c` / `-r`)                                      |
| `images`          | `unsupported`  | print mode / `-p` (send text only)                                      |
| `modelSwitch`     | `unsupported`  | print mode / `-p` (no in-turn model switch)                             |

Optional `HarnessCapabilities` keys `detach`, `terminateSession`, `viewHistory`, and `hostManagedModel` are **omitted**. Omission means they are not advertised; consumers must not treat a missing key as `supported`.

The six `unsupported` fields share one reason that names print mode, `-p`, and every unsupported surface (`tools`, `approvals`, `history`, `resumeExecution`, `images`, `modelSwitch`). A probe or `harnessManagedSupport` result of `supported` only admits the CLI. It is not evidence that those fields work.

`hostManagedSupport` stays `unsupported` even after a successful probe. Devin keeps models on its own account path.

## Known limitations (`-p` only)

1. **Print argv is fixed** — each send is `devin -p --respect-workspace-trust false -- <text>`. Non-interactive `-p` cannot show the workspace trust prompt, so the trust flag is always `false`. Tests must observe that argv, not only a successful stdout.
2. **No structured tools or approvals** — `tools` and `approvals` are `unsupported`. Stdout is opaque text; no `interaction.requested`, no tool events. `resolveInteraction` throws.
3. **No history replay** — `history` is `unsupported`. The adapter does not read a CLI transcript back into the Host journal.
4. **No resumeExecution** — `resumeExecution` is `unsupported`. Each send is a fresh `-p` process; no `-c` / `-r`, no export/ATIF session id capture.
5. **No images** — `images` is `unsupported`. `AgentCommand.send` carries text only.
6. **No modelSwitch** — `modelSwitch` is `unsupported`. Models stay harness-managed; Host does not switch models inside a print-mode turn.
7. **Auth is ambient** — relies on user `devin auth` / env (`WINDSURF_API_KEY` / `DEVIN_API_KEY` if present); Host never mints tokens.
8. **Print mode is not ACP** — Host lazy registration stays on `-p`. The optional ACP profile speaks `devin acp` via the shared ACP session machine. Do not register print-mode and ACP adapters together under id `devin`.
9. **Real CLI not required for CI** — admission/SessionHost tests use a fake executable that answers `--version` and requires `-p` plus `--respect-workspace-trust false`.

## Out of scope (later waves)

- Switching Host lazy admission from print-mode to ACP by default (id collision / migration).
- Capturing native session id for `-r` resume on the print-mode path.
- Tool / approval / file-change event translation beyond what ACP negotiation already exposes.
- Cloud (`--cloud`) and SSH session steering.
