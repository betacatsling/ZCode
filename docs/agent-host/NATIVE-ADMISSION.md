# Native owner maintenance admission and configured metadata path

Native CLI worker owns the V4 CommandInbox and its live runtime. A trusted Node-local owner may request freeze → inspect fresh activity → automatic maintenance → release; browser/remote GUI cannot request freeze/release. Frozen means new create/send/resume and internal automatic admissions are refused at the CLI owner, not held for post-maintenance replay. Existing identical command retries, command query and read-only history remain usable; cancel/stop and interaction resolution of already accepted work remain usable. Freeze has a random process-epoch lease; stale release cannot clear a new lease. Crashes, lost owner connection, failed maintenance and uncertain activity block automatic maintenance, not implicitly unfreeze a still running worker. Explicit operator stop is a different path.

```text
trusted Node owner → current worker control request → inbox freeze (sync)
                                             → fresh activity snapshot
                                             → maintenance only if quiescent
                                             → release same lease + epoch
client → inbox → reject new admission while frozen; duplicates/query/cancel still resolve
```

Owner is the worker process; existing CommandInbox is the only serial input admission owner. Freeze is installed synchronously before any await in command handling or snapshot collection. No pre-freeze asynchronous lookup can commit a new admission after freeze: recheck at the final admission decision. Unknown runtime/tool/approval/queue facts block maintenance. Internal timer/auto-drain may finish already accepted work but cannot originate new user intent. Desktop continuous and mobile replayable subscriptions retain existing ordering and do not become control authority. Node port must target the existing worker (never spawn on inspection). Epoch/lease must not enter storageState/startup notification or ordinary persisted settings.

Native metadata path is a read-only *path resolver*, not a DB opener: use the same config precedence and resolution used by bootstrap startup, with native launch cwd explicitly supplied for relative settings. No migration, no file writes. `startup/storageState` remains databaseId-only. Missing config/worker identity is not a reason to guess a default for a different worker.

Acceptance: deterministic pre-freeze-await race; pinned duplicate, query, cancel, new create/send and release mismatch; real worker round-trip; custom relative path from env/config and cwd; no DB creation on path lookup. A count of GUI-visible running turns alone is insufficient for safe automatic maintenance.
