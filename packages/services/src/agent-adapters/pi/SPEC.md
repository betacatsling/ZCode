# Pi worker file tools (SDK 0.87.1)

Owner: the Pi worker owns turn/permission admission and a bounded per-call file broker; the broker owns a pinned OS cwd and file descriptor from preparation to effect. The SDK owns the native tool loop and edit/read/write semantics via `create*ToolDefinition` with injected operations. Only `read`, `edit`, `write`, `bash` are active; custom definitions replace, not supplement, SDK defaults. Bash has its own explicit permission and **is not sandboxed**.

```
Model tool input → worker preparation (turn + immutable input, broker cwd/FD)
  → interaction.requested (write/edit/bash only)
  → resolve same call/turn → SDK custom execute → broker FD IO → SDK tool result
                         └ deny/abort/terminate → broker closed (no creation)
```

The worker pins the verified worktree root inode. For each operation it resolves input relative to the frozen session cwd, rejects lexical escapes, and spawns a fixed Node broker with the target parent as cwd. The broker verifies the actual cwd's ancestor chain by `..` against the pinned root device/inode **before** opening the leaf; each ascent is kernel directory traversal, not pathname symlink resolution. It holds the parent cwd and existing regular leaf descriptor while approval is pending. Symlinks/special files refuse; opens are `O_NOFOLLOW|O_NONBLOCK`, and existing write/edit reuse the same FD. An absent write is only created by `O_EXCL|O_NOFOLLOW` after allow; SDK mkdir is constrained to the already-held directory. Concurrent mutations of a previously approved inode can still occur from other OS actors; this is not an isolation sandbox. If the parent is renamed after verification the broker remains anchored to the same directory inode. Unsupported platforms are refused by adapter probe/capabilities and fail worker boot before offering ambient-path tools (Mac/Linux certified path; Windows explicitly gated until process cwd/ancestor guarantees and tests exist). No images, no new parent directories, no nonregular files. Broker IPC is one bounded operation at a time, fixed executable and script, with empty inherited environment and no shell. Maximum eight prepared brokers per worker, file payload <=4 MiB; close on denial, abort, failed turn, detach/terminate, worker exit. No path or contents in diagnostics.

Acceptance: real pinned SDK worker + Host and fake Model: Read, denied Write (no file), allowed Write, Edit, Bash, later turn reads changed content. Input/turn admission asserted. Deterministic root/parent/leaf move/symlink and missing-leaf replacement races leave outside sentinel intact; aborted new write absent; FIFO refuses without blocking. Actual macOS execution, Linux execution separately reported, Windows unexecuted fail-closed.
