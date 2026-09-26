# Native legacy-session activation and conversation regressions

## Ownership and boundary

The CLI SQLite session store is the authority for each existing Native session ID, transcript, title, saved model/execution selection, workspace path/identity, and permission rules. The existing CLI runtime is the only owner that activates or executes that session. `session/resume` and V4 `conversation/subscribe` must hydrate the original persisted row; they must not allocate a replacement session, Agent, Git worktree, or second accepted-input queue. Core may reference that original ID through its current Native mapping, but this regression suite does not change Core mapping, Target, hierarchy, or journal ownership.

The CLI `CommandInbox` serializes accepted V4 input. A conversation subscription is a view only: detach/reconnect/resubscribe and an exact command retry must observe the same admission, never replay it. The core runtime owns fork/edit/side-session transcript semantics, while the V4 handlers translate stable projected row targets and register only committed child sessions. `renameSession` changes the existing session's custom title; automatic title generation must not replace it. The V4 projection is derived from the transcript and must keep `model-only` messages out of user-visible history without removing them from model context.

```text
legacy SQLite session + saved config/permission
  → existing CLI runtime activates same session ID/cwd
  → V4 projection exposes visible rows (model-only remains hidden)

V4 input → one CLI CommandInbox → runtime turn/queue → SQLite transcript/events
                         ├→ detach/reopen subscription: read projection only
                         └→ duplicate command: return prior admission, no replay

fork / selection-side-session → new original CLI child ID + parent/source facts
editUserQuery → same session active-branch edit; no hidden replacement child
renameSession → CLI runtime custom-title fact → V4 snapshot; custom remains sticky
```

## Product rules and representative acceptance

1. **First activation of legacy history:** Seed a real legacy SQLite session with a non-default workspace path/identity, saved selection/execution state, permission mode/rules, visible transcript and model-only context. Activate it through public CLI stdio/V4 subscription (and resume where relevant). The returned owner and projection retain the original ID and path, selected model/mode/permissions; only the visible row appears in user history; no replacement session or Git worktree is allocated.
2. **Fork/edit/selection-side-session:** Exercise actual public V4 commands against a disposable native session. A stable assistant fork receives one distinct child ID with correct parent, transcript boundary, model binding and visible lineage while the parent remains unchanged. A selection side-session receives a distinct child and the intended selection/context without mutating the parent. Editing the latest real user query changes the same session's active branch and does not create an unintended child or leak branch-only rows.
3. **Busy queue and view lifecycle:** Hold a real fake-loopback Model request open, admit one follow-up through V4 while busy, detach and resubscribe (desktop-continuous and web-remote-replayable are distinct projection profiles over the same owner), and retry the exact command identity. The command remains one accepted item, executes once in admission order after release, and cold SQLite facts do not imply a second replay. Unknown completion stays unknown rather than becoming success.
4. **Title and visibility:** Rename through `renameSession`; cold reopen/resubscribe preserves the custom title even after another real user turn. Model-only transcript rows remain absent from the visible projection/history while still belonging to the active model transcript. Visibility is not inferred from role or text.

Evidence must come from a disposable SQLite database, the real public CLI process/CommandInbox/current Model executor, and a fake loopback upstream only. No paid provider, production enablement, real credentials, UI/global service, or fabricated Core/CLI result is allowed. Existing docs `native-create/RECEIPT.md`, `native-create/CORE-JOIN.md`, `agent-host/NATIVE-BOOT-SEAM.md` and `agent-host/NATIVE-ADMISSION.md` remain the governing create, activation, configuration and queue contracts; this spec does not relax their fail-closed recovery rules.

## Fixture lifecycle contract

The disposable parent owns the loopback HTTP server and CLI child. Launch failure closes both. Every frame wait has a deadline and rejects immediately on child exit; test cancellation/timeout must terminate and reap the child before removing its root. Normal close first allows clean EOF, then escalates to TERM/KILL with bounded waits; it must also close open upstream connections so an outstanding model request cannot keep the suite alive. A test's timeout alone is not cleanup (the previous 45s timeout left a child running for minutes). Never convert a failed test into a green result by swallowing its cleanup failure.

## Executable slice: legacy follow-up

After cold reopen, send one new V4 `sendText` on the original session, using the saved model selection and mode. The loopback Anthropic-compatible streaming upstream must return a real final text through the current Model adapter. Assert the accepted command, completed turn and visible assistant row, exactly one upstream request, then retry the identical command identity after view resubscription: it must report duplicate and make no second model call. No second SQLite session may appear. This exercises the real CLI CommandInbox; it is not evidence of Core-mounted public factory integration or live credentials.

## Current bounded plan

Add a unique `nativeLegacyProduct*` subprocess regression fixture/test beside the existing Native product tests, reusing the established disposable fake-Registry CLI subprocess entry. Execute a genuine failing case before any behavior edit. If a failure crosses the protected CoreAuthority/hierarchy/journal/Target, bootstrap entry/server/CommandInbox, Model/private-effects, UI/Phone or Supervisor owner, retain the exact test and request that owner's seam rather than bypassing it. Only edit a legacy V4 handler or core runtime method when the public-path test demonstrates the defect.
