# Native bootstrap path and trusted registry seam

Owner: the native ZCode protocol bootstrap opens its one session SQLite store and owns its provider registry runtime until transport shutdown. The CLI/server remains the sole owner of accepted commands, approvals and model execution. No renderer/RPC account API gains API-key access.

```
prepare(config, launch cwd) → configured DB path → handshake → open/close
normal(config, launch cwd)  → same configured DB path → open → V4 transport
trusted Node caller → registry runtime factory → real Registry → existing Model executor
                              └→ bootstrap finally: dispose once (including late acquisition)
```

Both paths use the same `createConfig({env})` and `getSessionDbPath(config, options.cwd)` resolution. `process.cwd()` is only the resolver's fallback when launch cwd is absent. A relative configured path must not select two databases when `process.cwd()` differs from launch cwd. No new migration, path in startup event, alternate model client, or persistent credential. The trusted optional factory argument of `runZCodeProtocolAgent` is process-local Node composition, never JSON or protocol input; the default starts the existing process registry. The injected factory must return the existing runtime/registry contract (the actual `ProviderRegistryService` and lifecycle), not an alternate Model implementation. Acquisition races with abort dispose the late runtime exactly once; normal shutdown disposes after server sessions and storage. Failure before registry acquisition leaves no registry to dispose.

Acceptance: relative-path mismatch regression for normal and prepare paths with isolated env/DB; real V4 child stdio and fake upstream via the injected real Registry and existing Model executor. The fake fixture proves real native Read tool delivery and a second turn reading content changed only after the first terminal V4 projection; it authorizes only read-only fake requests. Write/Bash permission and effect assertions, paid usage, and local paid provider runs are separate gates, not implied by this fixture. No live credential in file/log/test output; default tests never use paid models.
