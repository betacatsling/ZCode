# Existing external session UI routing (P2/P3)

## Behavior and scope

A Project sidebar row is selectable as an external conversation only when its
`SessionHierarchy` record is linked and the target Host summary proves the exact
same owner locator. Selecting it mounts the existing V4 `SessionPane` body over
the AgentHost `ConversationTransport`, so the user can read the current history,
load older pages, send input, resolve an approval, stop the foreground execution,
and recover after a disconnect. This slice does not create a new AgentHost
session and does not change the native V4 create, history, or routing path.

The click passes the complete typed owner locator: linked hierarchy record,
Host `SessionSpec`, attached `remoteSessionId` (if remote), the original owner
workspace path and identity, and a renderer attachment generation. A Host ID
alone is never a routing key. The hierarchy locator and Host summary must agree
on owner kind, target, identity, worktree path, Harness, and session ID. The
target-scoped service must also report the locator's target ID before the V4
body mounts. Project membership and the visible workspace root do not replace
the owner path or identity.

## State ownership and failure behavior

The Host owns canonical events, execution, approvals, history, and command
receipts. The existing V4 `SessionDataLayer` and projection store own only the
renderer subscription and derived view. The Project sidebar model's owner map
is a disposable route projection of `SessionHierarchy` plus bounded Host
summaries; it is not another session registry or business-state owner. The app
shell owns only which primary conversation is selected. It never writes an
external ID into native task/session selection or persistence.

The native path remains the same when no external owner is selected or this
route is disabled. In external mode, every transport operation must match the
selected complete owner locator and its target attachment generation. A late
load or event from another generation is ignored. Missing, incomplete, stale,
or mismatched ownership is shown as unavailable and is rejected; it must not
fall back to a native API. The V4 transport retains Host ACK activation,
epoch/sequence recovery, command idempotency, stop execution identity, and
approval identity checks. Reconnect reuses the same Host locator and never
resends a prompt.

This initial UI route exposes only capabilities already supported by the
AgentHost transport: history, text input, approvals, stop, and reconnect. UI
operations that require native task/worktree mutation or uncertified external
capabilities are hidden or explained. Their Host-side rejection remains in
force. Generic Web service access does not enable the route; remote sessions
must use the existing authorized attachment scope.

## Owners and event order

```text
Project sidebar row
  → linked SessionHierarchy record + exact Host summary
  → app-shell primary selection (complete locator, selection generation)
  → existing target attachment + target-ID check
  → V4 AgentHost transport / ACK activation
  → Host journal and command owner
  → SessionDataLayer + ConversationProjectionStore (derived UI)
  → existing SessionPane body

input / approval / stop
  → selected SessionPane and command ID
  → typed AgentHost transport (full locator + expected epoch/execution/interaction)
  → Host admission / receipt / canonical event
  → V4 frame assembly and projection

attachment reconnect
  → newer attachment generation
  → invalidate old route and pending reads
  → verify the same target and full locator
  → subscribe/recover the Host snapshot; never resend accepted input
```

## Acceptance cases

1. Clicking a linked Pi row in the actual React/Vite Project sidebar mounts the
   existing V4 Chat body and displays the Host snapshot. The cold empty snapshot
   transitions to visible user and assistant rows when the first Host events
   arrive, and the timeline follows the new tail without losing scroll access.
   A same-path session on another target cannot satisfy the locator.
2. An executable browser test uses an isolated, no-provider Host and the real
   service-port/bridge/transport path. Its Pi fixture emits the user message,
   explicit assistant output, structured tool start/result, and approval events
   that the UI contract promises. Assertions query visible DOM inside the
   selected external conversation body, excluding hidden nodes and fixture
   controls. The test separately captures Pi A's blocking approval and the
   conversation body after approval, where the sent user text, assistant reply
   and successful file-write summary are visible. The Host snapshot also checks
   the exact successful tool output; the existing V4 file-write card presents
   that result as the file summary/diff instead of repeating a generic output
   block. The test exercises existing row collapse/expand controls in both the
   transcript and older history.
3. The browser records the bounded Host tail and any older pages the existing
   turn directory has already loaded. It then scrolls to the actual oldest
   marker, expands that turn, and verifies every Host range page uses an
   exclusive cursor with strictly ordered row IDs. The loaded UI window remains
   unique and matches the Host total, and the evidence screenshot shows the
   older message bodies.
4. Approval begins as a pending interaction in the Host service-port backend.
   The accepted choice must use that snapshot's exact interaction ID, active
   turn ID and runtime epoch. A stale turn/epoch answer and a late resolution
   event cannot release the pending interaction.
5. Two Pi sessions and one native session under one worktree remain distinct.
   The browser keeps A running after its approval while B waits at its own
   approval, stops A, and verifies that B remains running with its approval
   still readable and actionable after selecting B. The service integration
   test also covers stopping A while both Host approvals are pending. Background
   Host summary/frame updates do not steal focus,
   selection, or an input's selection range; native APIs never receive either
   external ID.
6. A failed subscribe recovers through the existing V4 resync path. A delayed
   result from an earlier Host/attachment generation cannot replace the current
   target, including when two targets use the same workspace path.
7. With the external route disabled, selecting and reading a native session
   uses the original native V4 provider unchanged. Existing native history and
   creation continue to work.
8. Higher external capabilities remain unavailable in the UI and are still
   rejected by the Host. This slice does not claim live Provider, SSH, or full
   Electron certification. Browser reports list only screenshots actually
   captured and state that the Pi is an external-only fixture.
