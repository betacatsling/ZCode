# Project sidebar UI (v0.3 bounded component)

## Owner and interface

`ProjectSidebar` consumes a **Host-produced** `SidebarSnapshot` and registry `HarnessCatalogEntry[]`; it does not fetch transcripts, inspect Git, or infer projects from tabs. Caller supplies typed action callbacks for selecting an existing session, create agent, discover/adopt/create, hide/archive/remove, and attention navigation. Caller must refresh snapshot after successful mutation; a rejected callback leaves the current tree intact. Neither UI nor view store claims target authority. Discovery candidates are read-only transient props (path/branch/target), never workspace IDs until adopted. The parent mount owner connects callbacks to authoritative service and supplies target labels, validated icon resolver, and locale. No app-shell/legacy sidebar mutation here.

```text
Host Catalog + activity index → immutable SidebarSnapshot → ProjectSidebar rendering
Host Harness registry ────────────────────────→ selector/icon rendering
user action → confirmation/form → injected callback → Host admission/mutation → new snapshot
                         └─ local view store (selection, expansion, drafts, scroll only)
background snapshot / reconnect → rendering only (never set selection or focus)
```

The view store is window-local. Persisting/restoring view state belongs to the mount owner; restoration must not supersede an explicit selection made since restore started. This bounded component does not install a localStorage writer; the mount owner may serialize the view store after reading user preferences. Project/workspace/session keys are stable IDs; ordering is explicit `sortOrder` then ID, never timestamp/branch. Summary counts are read exclusively from snapshot aggregates (including hidden workspaces); hidden waiting/error attention remains accessible through project attention entries.

## Rules and failure behavior

- Main and default are separate markers. Display execution target from binding, branch/detached from head. A zero-session main worktree stays visible. Removed entries remain in history only and cannot create sessions.
- `+ Agent` sends the existing workspace ID, its generation, chosen harness and model binding; it never creates a worktree. Warn that parallel agents share files/index. Isolated workspace uses a separate create operation. Disable unsupported/unverified Harness choices and explain why. Model information is separate from Harness icon, including when model changes.
- Asset resolver is a trusted synchronous `assetId -> same-origin absolute path | undefined` port; component independently rejects external URLs, protocol-relative URLs, backslashes and control characters. Never use raw IDs as URL/HTML. Missing or failed image falls back to a generic glyph/name; unknown Harness uses its raw ID, not a different brand. No brand roster in UI.
- Hide changes visibility only, archive changes catalog admission/display state, remove requests explicit Git removal and must be confirmed with external activity and file risk wording. Do not claim confirmation is the backend safety check; authoritative service MUST gate/remove. Discovery does not adopt/create/start agents. Dialogs accept Escape/cancel, descriptive labels, and keyboard activation.
- UI text has local en/zh dictionary until global locale mount is owned centrally. All actions are available on mobile; focus is never changed from background summary updates. The caller owns errors and may display actionable messages; rejected promises do not mutate view state or close a pending dialog.

## Acceptance scenarios

1. Two projects, four workspaces (including empty main), three sessions including two of the same Harness remain distinct and sorted; branch, detached, target, default/main labels and aggregate counts correct.
2. Hidden waiting workspace still has project attention navigation; updating ten aggregate summaries among fifty workspaces does not reorder entries or reset focused draft/caret.
3. Missing asset and unknown harness show safe fallback; changing model label does not change harness glyph. Picker is driven only by registry.
4. Desktop and mobile keyboard/dialog flow: discover does not mutate, adopt/create distinct, + Agent reuses ID, hide/archive/remove distinctly confirmed, no callback on cancel. All callbacks remain host-owned.
