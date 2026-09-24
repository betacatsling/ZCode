# Desktop → persistent local Core attachment

Main owns only a window-to-Host process map and starts/queries the installed standalone CLI from an explicit, packaged runtime. It never stores session state. The Core/Supervisor owns native CLI admission, external Host journals and receipts. Each window has one Local Host process, with one trusted RPC attachment to the Core. The Host forwards Core-owned service channels to its renderer; it does not create another external Host or native executor. A missing packaged Core or mismatched identity/version blocks attachment (not a silent local-executor fallback).

```text
Main packaged CLI serve/status → ready generation/port
  → authenticated installation ID from owned root → Core /api/server-info check
  → Core one-use ticket → window Host Core RPC socket
  → Host local renderer MessagePort (desktop-continuous) → Core service authority
reload → same Host + fresh renderer port; close → Host/socket close only
mobile → web-remote-replayable snapshot/gap repair, never this desktop stream
```

Main resolves the stable installation identity from a trusted local root (never trusts the HTTP endpoint alone); Host repeats the identity, protocol and version handshake and consumes exactly one short-lived ticket. Reconnect requires a fresh status and ticket. An accepted command is never resent solely because an attachment dies: query its Core receipt and check owner/lease/epoch before another action. The window registry serializes attach per window, rejects stale completion after close/reload, and disposes only the previous socket; it does not stop Core. Until the service composition exposes a non-owning Desktop view and a packaged CLI is shipped, the mount must fail closed rather than silently starting a second native worker. Test with disposable Core/Host processes, temporary root, no real app profile; GUI/packaged verification is separate.
