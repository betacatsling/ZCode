# Paired phone attachment and remote scope boundary

Default OFF. Desktop user enables and explicitly consents to one workspace on the current window-scoped Host. Main owns bounded one-use challenge/device lease; Host owns method/argument/event projection on each attachment; Core owns session/accepted command/journal. Phone browser carries only a device credential (never the Core ticket), connects over authenticated origin/CSRF-bound transport, and receives replayable snapshot + gap events from the same Host. Non-loopback deployment requires TLS/WSS. Revoke, expiry, Host replacement or window close closes live views and blocks all future effects; never stops Core business work. Reconnect to the same current Host resumes the same session and interaction request ID, never resubmits input. No account stub may masquerade as authentication.

```
desktop consent → Main one-use challenge → device lease → Host-scoped replayable port
                                                      → Core session/journal (only business owner)
phone disconnect → journal continues → authenticated reattach → snapshot + cursor gap
revoke/rotate → close views; stale requests denied, Core run untouched
```

For existing remote hierarchy create, the renderer-supplied workspaceId is NOT authority. The target Core Host availability target ID and hierarchy's Catalog-backed resolved workspace must match captured attachment path, identity and target BEFORE createAgent; the Host registry separately certifies the remote session/generation (target Core need not know Desktop's remoteSessionId). After any async read Host checks current registry generation again immediately before the effect. A potentially accepted call or lost ACK is uncertain even with an unchanged generation: no retry; only read-only stable command recovery once provided by Core. Returned owner validation remains a separate post-effect safety check, never a substitute for pre-effect authorization. All other phone-exposed service methods must be explicitly scoped or denied; generic window port is forbidden.

Acceptance: actual two-workspace Core fixture must show wrong ID causes zero foreign creation/input/model effects; same-path foreign identity denied. Stale generation during lookup and after admission denied/uncertain without resend. Browser via actual authenticated port and shared Shell/Pi, active revoke and replayable gap recovery must pass before this feature is called delivered. Desktop-continuous checked independently. Native create metadata is selection/provenance, not authentication; production Native join is separate from local phone delivery.
