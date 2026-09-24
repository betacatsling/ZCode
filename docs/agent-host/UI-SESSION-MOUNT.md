# Mounted session pane — UI owner

The native session branch remains the existing SessionPane and native V4 transport, without changing its create, editing, fork, queue, share or model-selection machinery. An external pane requires a trusted resolved owner (target, stable workspace, original Host session ID and saved spec); an unknown ID is never classified from its string or path. The Host journal and projected snapshot own accepted commands, interactions, rows, epoch and turn. Renderer owns only a per-pane unsent draft and view lease. UI never inserts external IDs in the native task database. Feature-off uses the original native transport object; turning off new external admission does not hide already accepted sessions.

The shell must supply a target-scoped `MountedSessionOwner` from WorkspaceHierarchyService.resolveOwner; `targetId` cannot be derived from workspacePath or SSH connection ID. The UI session mount consumes the optional accessor's hierarchy + Host services, and must reject mismatched workspace/identity/scope/spec before subscribing. A pending/absent resolver shows a safe waiting/error state, not a native pane. New creation is exclusively the hierarchy's `createAgent` (Host reservation/receipt); SessionPane's native draft-create remains native-only. External sends use immutable per-click command IDs, no retry after uncertain receipt, approval/cancel include the active turn and epoch; reconnect only subscribes/queries/snapshots, never resends. Capability report gates every optional action with a visible reason; unsupported native-only operations are not rendered. Approval displays success only after Host receipt.

```text
shell owner selection → trusted hierarchy resolveOwner → UI owner validation → Host snapshot/subscribe
                          └─ native original ID → original V4 pane
external composer click → one Host dispatch(commandId,turnId) → receipt → Host projection
reconnect → Host snapshot/eventsSince (no send); stale epoch/turn → reject
Desktop continuous ── live events ─┐
Mobile replayable ── snapshot/gap ─┴─ same Host owner/epoch/sequence
```

Acceptance: native feature-off transport identity and advanced actions; two Pi sessions and one native sharing workspace without cross-selection/draft; missing/mismatched owner no native RPC; ACK activation and late reply; reconnect never resends; unsupported controls reasoned; approval denial must not be shown as allowed; mobile and desktop pane accessibility. This UI slice cannot certify production navigation until the hierarchy service accessor and the shell pass a target-scoped owner; cannot certify live process/SSH without integration.
