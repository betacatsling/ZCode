# Multi-harness v0.3 P0 snapshot evidence

Evidence timestamp: 2026-09-24; checkout `1e7c0e24a692b426bf339f643dadf3c5a91ec611` (`goal/5be7ed74-baseline-check`). This is the **partial implementation safety snapshot**, not the older plan's `328c1a0` source reference. `ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` governs the goal; older v0.2/P0 claims are not certifications. P0 inventory and deterministic gates only: no credentials, live model call, personal SSH, native GUI or remote execution were used. Generated dependency/build outputs stay in this isolated worktree; logs and Git fixtures stay under `/tmp/zcode-mh-baseline-1e7c0e2/` (not tracked).

## Actual executable gates

All pnpm gates below used `mise exec -- node scripts/mise-run.mjs pnpm ...` so scripts inherit Node **24.14.0** and pnpm **10.33.2** (`mise.toml`); direct `mise exec -- pnpm install` gave an unexpected Node 26.8.1 engine warning in a child script, despite `mise exec -- node -v` returning 24.14.0. Install succeeded offline with `--ignore-scripts`; it does **not** establish native/Electron binary readiness. Re-run installs through the wrapper for reproducibility. No test data directory outside `/tmp` was used.

| Gate (root cwd unless noted) | Outcome; log in `/tmp/zcode-mh-baseline-1e7c0e2/` |
|---|---|
| `mise exec -- node scripts/check-workspace-freshness.mjs` | pass, relative to origin/main ahead 3 / behind 0; branch lacks remote tracking |
| `mise exec -- pnpm architecture:check --changed` | pass, 0 violations; documentation-only edit; context example `mise exec -- node scripts/mise-run.mjs pnpm architecture:context services` passes but reports `services` unmanaged, so it is not an ownership certification; `architecture-context.log` |
| `mise exec -- pnpm install --offline --frozen-lockfile --ignore-scripts` | pass, 1978 packages, no downloads; engine warning described above; `install.log` |
| `mise exec -- node scripts/mise-run.mjs pnpm typecheck` before CLI dependency build | **failed**, TS2307 for `@zcode/contracts` and `@zcode/adapters/model` dist exports in Pi/model-binding files; absent generated package outputs after script-free install, not proven source defect; `typecheck.log` |
| `mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/adapters... build` then `mise exec -- node scripts/mise-run.mjs pnpm typecheck` | pass for narrow dependency build then root TypeScript references; `prereq-build.log`, `typecheck-after-prereq.log` |
| `mise exec -- node scripts/mise-run.mjs pnpm lint` | pass, **70 warnings, 0 errors** over 2664 files; warnings are not a clean lint report; `lint.log` |
| `mise exec -- node scripts/mise-run.mjs pnpm exec tsx --test packages/services/test/agentHost*.test.ts packages/ui/test/agentHostConversationFacade.test.ts` | pass **27/27**; `agenthost-tests.log`; SDK Pi with fake executor ≠ live Provider certification |
| `mise exec -- node scripts/mise-run.mjs pnpm build:bootstrap` | pass, desktop renderer + package build with Vite chunk-size warning; no runtime assets/package installer; `build-bootstrap.log` |
| `mise exec -- node scripts/mise-run.mjs pnpm --filter @zcode/cli... build` | pass, CLI bundle built; `cli-build.log` |
| `ZCODE_DATA_BASE_DIR=/tmp/zcode-mh-baseline-1e7c0e2/isolated-data mise exec -- node apps/zcode-cli/packages/cli/dist/zcode.cjs --help` | pass, CLI reports 0.16.9 and app-server command; **not** an app-server request or Agent lifecycle; `cli-help.log` |

A distribution smoke script exists at `scripts/zcode-distribution-smoke.mjs <archive.tar.gz>`; no distribution archive was built, so it was **not run**. `pnpm prepare:desktop-runtime`, `pnpm bundle:desktop`, isolated GUI lifecycle, native interactive approvals/resume, SSH execution, and provider calls are also **not run**. These are missing P0 acceptance evidence rather than passed gates. Building only in this worktree avoids sharing generated source with the main checkout.

## As-is owners and lifecycle (inspection, not live trace)

```text
Window UI tabStore (workspacePath/identity, focus and expansion; NOT persistent Project Catalog)
  -> UI V4 transport: commands, ACK/query, snapshot/delta, resync, rows
  -> Desktop window-scoped Local Host / service RPC (or server attachment)
  -> IZCodeAgentService -> ZCodeAgentProcessManager keyed by workspace identity
  -> stdio native ZCode CLI -> V4 CommandInbox/admission + native session/projection
  -> ApiProviderModelRuntime -> Provider Registry -> AiSdkModelAdapter -> Model
  -> response/event via V4 -> UI projection store (sequence/gap handling)

External partial path (opt-in): target RPC -> lazy AgentHostTargetService
  -> SessionHost admission/journals -> Pi worker/SDK -> bindHostModel
  -> same Provider Registry + AiSdkModelAdapter; projected external V4 subset.
UI createAgentHostConversationFacade selects native/external by owner, but there is
no observed production UI mounting/call site for this facade. Native remains owner
of native sessions. Mock/fake tests do not demonstrate production end-to-end wiring.
```

Source seams: `packages/ui/src/store/tabStore.ts`, `packages/ui/src/v4/{transport,conversationProjectionStore,agentHostConversationFacade}.ts`, `packages/services/src/{node,zcode-agent/zcodeAgentProcessManager,agent-host/{lazyTargetService,targetService,sessionHost}}.ts`, `packages/services/src/agent-adapters/pi/createPiHarness.ts`, `apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.ts`, `apps/zcode-cli/packages/adapters/src/model/model.ts`. SessionHost journals are external history/command records, **not** a replacement owner for native CLI V4 facts.

```text
Remote workspace: Desktop window remote registry -> remote backend detect/upload/exec
  -> SSH attachment/remote server Core -> remote workspace Agent/service over stdio.
Desktop uses desktop-continuous stream; web/phone uses web-remote-replayable
snapshot/gap repair. Disconnection ends attachment; remote backend exec() alone
cannot certify worker/next model call survives GUI exit.
External experimental: server Core may register lazy target agent host; remote
workspace service collection forwards IAgentHostService. No standalone target
supervisor/fencing or GUI-exit/reconnect certification shown by this snapshot.
```

Owner/event order to preserve: client command ID -> target admission persisted -> backend dispatch -> sequence/epoch event journal -> projector/read-only UI; reconnect queries receipt and sequence, never resends uncertain prompt. `targetService.ts` keeps in-process hosts/listeners; `lazyTargetService.ts` authorizes absolute paths on a trusted channel, not a verified Project/RepositoryBinding/worktree generation. Its `close()` calls worker shutdown; no independent daemon guarantee. `agentHostConversationFacade.ts` fails closed for unknown owner and returns native object when disabled, but lacks composition evidence.

## §13 old-to-new mapping and disposable Git fixtures

```text
Existing window tab(workspacePath, workspaceIdentity, view state)
  + persistent native session indexes/history (not just open tabs)
  -> [proposed] Project Catalog -> RepositoryBinding(targetId + Git common dir)
  -> WorktreeWorkspace(worktree ID/generation/main flag/target; cwd kept)
  -> AgentSession(hostSessionId -> workspaceId; native ID preserved).
The present checkout has tabStore + Git main/linked/not-repository types,
not an authoritative Project Catalog, WorktreeService or migration transaction.
Never map by branch name, tab presence, or path alone; do not git init old folders.
```

`git version 2.50.1 (Apple Git-155)`; locally created **only in `/tmp`**: `git-fixtures/main` (initial commit), `git-fixtures/linked` (`git worktree add -b linked`), `git-fixtures/bare.git` (`git init --bare`), `git-fixtures/non-git` (plain dir). `git worktree list --porcelain -z` returned two records; `rev-parse --path-format=absolute --git-common-dir` returned the same common dir for main/linked, bare returned `true`, and non-Git `--show-toplevel` failed as expected (`git-fixtures.log`). These prove Git fixture construction and parser input availability, **not** ZCode's planned discovery/adoption service. Same absolute path on two different execution targets cannot be tested with two distinct local `/tmp` directories: fixture requires two isolated target backends/namespaces exposing identical `worktreePath` with distinct stable target IDs, plus colliding native session IDs to verify no cross-target attachment. SSH/offline target requires separately authorized disposable Linux host and version/cwd check. No personal SSH aliases or credentials inspected.

See `ACCEPTANCE.md` for every P0–P6 and §13 release criterion and `third-party-source-map.md` for CodexHost licensing. All missing live/GUI tests remain open.
