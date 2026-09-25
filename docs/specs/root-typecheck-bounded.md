# Full root TypeScript gate with bounded resident compiler

The former `tsc -b` invocation in the root `typecheck` script exceeds the required 2048 MiB per-process heap even after building CLI declaration prerequisites. This changes only build orchestration, not the checked source set or TypeScript options. Keep the **same eleven entry projects** from the existing root script; resolve every transitively referenced tsconfig from the checked-out tree, fail on missing/malformed config or cycles, then invoke the repository-installed TypeScript compiler in a separate, sequential process for each project in topological order. Never infer success from transpilation, built artifact presence, or a partial subset. Project references remain TypeScript's own inputs to each `tsc -b` call; TypeScript incremental validity (not this runner's timestamp guess) decides whether a project must be rechecked. No `--noEmit`, `--skipLibCheck`, heap increase, or deletion of `tsbuildinfo` to force success.

Owner: root build script owns the process sequence only; each project's tsconfig owns its dependencies and TypeScript owns diagnostics/incremental state. This is not a second product state owner. Event order:

```text
root entry tsconfigs → async read of referenced tsconfigs → topo closure
                                                → pinned process.execPath + installed tsc -b project
                                                → wait for exit → next project
failure/signal ──────────────────────────────────→ terminate/stop, nonzero root gate
```

Acceptance: original eleven root entries and full reference closure appear exactly once in the plan; no project runs before a referenced dependency; an error, missing reference, cycle or child termination cannot yield success; one compiler child at a time, resolved using `process.execPath`, with signal forwarding. The same root `pnpm typecheck` must execute all projects and propagate any TypeScript error. Test with fixture configs and failing compiler, then run the real gate under shared memory slot. `pnpm lint` and architecture checks remain independent mandatory gates. Does not establish Core→browser or native capability acceptance.
