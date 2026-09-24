# acp-fencing early interface

No new public shared API. `AcpTransport.prompt(text)` still returns the native result only on a valid terminal stop reason; cancellation does not settle the pending prompt until the original native reply. A cancelled/uncertain connection cannot admit a new prompt. Adapter `send` throws for uncertain outcomes so Host's existing receipt path records execution-unknown; no schema/Host changes. Injected client callbacks/capabilities fail closed until independently fenced. Pinned 0.16.2 stays unsupported.
