# Sidebar Agent creation, Harness identity, and target history

## Product behavior

`+ Agent` on a Project Sidebar workspace creates an empty, durable session owned by the selected target Host. The form names the target and workspace, lets the user select a registered Harness and a model independently, and accepts an optional title. It does not create a Git worktree. Multiple Harness sessions may share one worktree; the form explains that their file writes share the workspace and does not block concurrent creation.

Harness choices come from the selected target's Host directory. A previous session in that exact workspace may preselect its most recently used registered Harness; a single registered Harness may be selected automatically. With multiple registered Harnesses and no prior choice, the form asks the user to choose. The model choice comes from the selected target's `IModelSelectionService` preferred selection; if there is none, the user chooses explicitly. Changing model never changes Harness identity.

Only a live attachment with open-new-session capability and an active, verified workspace generation can submit. Host capability reads report supported, unsupported, experimental, or unknown with a reason. Unsupported and experimental choices remain visible with their reason; only a supported report enables submission. Host create admission remains authoritative and revalidates the target, workspace ID, generation, path evidence, Harness, and model binding.

One unchanged form intent keeps one request ID across double-clicks and retries. Editing target, workspace, Harness, model, or title creates a new intent ID. After create returns, the UI reads the current Host owner and SessionHierarchy facts and routes only when they match the submitted target, workspace, generation, original path/identity, and Harness. It never presents a Renderer draft as a created session. Creation-triggered selection is explicit; background refreshes do not change the active project, workspace, session, or composer focus.

## History routing

Sidebar history rows retain their source target and original owner path, optional explicit workspace identity, remote session ID, and remote target. Native history opens through the existing native task route. AgentHost history opens the existing V4 conversation provider only after a full owner-index fact and matching owner SessionSpec are read from the same live target attachment. A history-only association may identify a read-only historic generation; it never authorizes execution or maps the session onto a replacement generation. Receipt-only, cold unknown, offline, or incomplete owner records show a clear waiting/verification state and never fall through to the active workspace's legacy list or an arbitrary target.

The existing legacy task surface stays mounted beside the Project Catalog surface, including when the catalog is non-empty. Native non-Git history remains reachable by its native owner and original workspace path.

## Harness presentation and assets

Sidebar rows, the Harness picker, and the Chat Header use the same Host directory entry, Harness ID, manifest name, icon descriptor, and icon resolver. A model selection affects model text only. Hosts serve checked-in, bounded static assets by validated opaque asset ID. Asset reads do not initialize an Agent, Model, or session runtime. Unknown IDs, stale asset descriptors, oversized or unsafe content, and service failures resolve to the shared accessible fallback. Recently read static assets may remain visible from the UI cache while their target is offline.

Pi's icon is derived from the official Pi terminal logo source and keeps source and license attribution next to the shipped Host asset. No provider or model-vendor icon is used as a Harness icon.

## State ownership and event order

```text
creation form draft
  → exact live target attachment + ModelSelectionView + Host directory/capability read
  → Host createWorkspaceSession(requestId, workspaceId, generation, harnessId, binding, title)
  → Host validates and persists Native V4 or AgentHost owner
  → Host owner-index + SessionHierarchy reread
  → explicit selection through native task navigation or existing AgentHost V4 provider
  → later sidebar refresh projects the persisted owner; it never selects by itself

history row(target, record)
  → exact target attachment and original path/identity/remote session
  → Native owner route, or AgentHost current-owner + SessionSpec read
  → existing owner route when facts match; otherwise visible verification state
```

The Host owns accepted creation, request idempotency, execution binding, and owner facts. SessionHierarchy owns the legacy-to-workspace history association. The Project Sidebar owns only unsubmitted form values and the stable request ID for the active intent. AppShell owns explicit navigation. Shared UI owns manifest presentation and bounded icon cache.

## Acceptance cases

| Setup and action                                                                 | Required evidence                                                                                                                              |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Create two Pi sessions and one native session on one verified worktree           | Three SQLite/native owner facts after reread/restart; no new worktree record; each row has its own Harness and model binding                   |
| Double-click, then retry after a transient create response loss                  | Same unchanged request ID reuses the persisted owner; editing any request field uses a new ID                                                  |
| Submit while attachment is offline, capability is closed, or generation is stale | No owner write; form values remain; UI explains the unavailable state; Host independently rejects stale admission                              |
| Select a created Native or Pi session                                            | Existing production V4 body shows the correct owner/session facts; Native remains on the native owner path; Pi ID never enters native task API |
| Select a target-B history row while target A is active                           | Route uses B's original owner path and B attachment; visible body and owner IDs identify B; no A legacy list substitution                      |
| Open unknown or cold history                                                     | Visible verification/waiting state; no first-target guess and no execution route                                                               |
| Render Harness identity in Sidebar, picker, and Chat Header; change model        | Name and icon remain tied to identical Harness ID/manifest in all three surfaces                                                               |
| Read a registered, unknown, traversal, oversized, or unsafe icon asset           | Registered small static asset renders; every invalid case falls back; asset read invokes zero runtime bootstrap calls                          |

Browser evidence must inspect visible body text and owner identity, and creation tests must inspect persisted Host/Native facts. DOM-node presence, callback counts, and container dimensions alone do not prove routing or creation.

## Implementation boundary

Reuse `IAgentHostService.createWorkspaceSession`, owner/history reads, the existing Model Selection service, `useModelSelectionServiceView`, and `V4AgentHostConversationProvider`. Add only the narrow Host capability/asset read needed by the UI. Do not alter SessionHost, Pi worker, native CLI/Gateway execution, or the shared Agent model-binding implementation. Preserve current multi-target, bare repository, native legacy, owner/lease, and stale-generation behavior.
