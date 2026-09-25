# Core occupancy recovery — trusted-supervisor proof, fail-closed by default

Status: implemented for `core-authority.json.lock` and the managed Core's workspace-hierarchy
occupancy markers. Approved policy change: automatic Core-level recovery is allowed **only** when the
trusted Supervisor proves the previous owner exited and was reaped. Unknown, alive, ambiguous,
PID-reuse, malformed or foreign locks stay fail-closed for manual recovery. A restarted service never
replays accepted-but-unknown commands.

## Threat model and boundary

In scope: a *compliant managed process* crash. The Supervisor launches exactly one `server-core`
child at a time over a private `fork` IPC channel, holds `run/server.lock`, observes that exact
`ChildProcess` handle's `exit`/`close` (the OS-level proof that the direct child terminated and was
reaped), and later launches a replacement. The recovery decision may only retire occupancy markers
that this same Supervisor incarnation can bind to a reaped managed generation.

Out of scope: arbitrary hostile same-UID filesystem/process attackers. A same-UID process can
already unlink or rewrite files under the same config root without our cooperation; supervisor-side
attestation raises the bar for *compliant* components and proves owner death, but it cannot make a
JS `compare→unlink` sequence atomic against a concurrent adversary mutating the file between the
last check and the unlink. The protocol never fabricates a writer: recovered files are always
removed, never edited to look legitimate.

Hostile-input hardening that **is** enforced: a forged lock record cannot obtain recovery unless it
carries the exact `{pid, ownerEpoch}` pair the trusted parent recorded from the owning child and that
child was observed reaped. A live foreign process, a foreign epoch, a reused PID under a foreign
epoch, malformed content and legacy records without `ownerEpoch` all fail closed without mutation.

## Who is the trusted supervisor

The only entity that may retire a Core occupancy lock is the *currently running* Supervisor that
holds `run/server.lock` and can answer all of the following from its own process state:

1. It spawned the recorded owner via `child_process.fork` on the private stdio IPC channel (peer
   identity is supplied by the OS, not by the payload).
2. While that child was alive it received the child's `occupancy-owner` IPC report carrying
   `{pid, ownerEpoch, installationId}`; the reported `pid` must equal the `ChildProcess.pid` the
   kernel assigned, and `installationId` must equal `install.json`'s `installationId`.
3. It observed that exact child's `exit` or `close` event — a Node parent only sees this after the
   child terminated and was reaped. `kill(pid, 0)`/ESRCH alone is **not** accepted as death proof
   (PID reuse makes it ambiguous); conversely an attested dead owner is retired even if the PID was
   since reused, because `ownerEpoch` binds the file to the dead incarnation, not to the PID.

A Supervisor restart loses the in-memory reports, so a *new* Supervisor can never retire locks left
by a previous Supervisor's children; those remain on the manual path. A detached/standalone Core that
was never launched over the trusted IPC has no report and likewise stays manual.

## Occupancy lock inventory and per-lock preconditions

| Lock file (under `getAppConfigDir(<child dataBaseDir>)`) | Writer | Recoverable? |
| --- | --- | --- |
| `core-authority.json.lock` | `ProfileFileOwner` in `createCoreAuthority`; held for the whole Core service collection | Yes, with full proof |
| `workspace-hierarchy/profile/catalog.json.lock` | `ProfileFileOwner` via `ProjectCatalog` lazy composition | Yes, with full proof |
| `workspace-hierarchy/target/<sha256(targetId)>.owner` | `TargetAuthorityStore` via `TargetWorktreeService` lazy composition | Yes, with full proof |
| `native-migration/mapping.json.lock` | `LegacyWorkspaceMigration` (opened outside the managed Core lifetime; owner may be an agent CLI child) | **No** — owner is not provably the managed child; manual path |
| agent-host `*.commands.jsonl.lock` / `*.events.jsonl.lock` | `CommandJournal`/`EventJournal` writers; payload is PID text only | Existing PID-ESRCH stale path retained unchanged; **not** promoted to supervisor proof in this change — remains a separately scoped boundary |
| `agent-host/<sha256(hostSessionId)>.owner.json` | `SessionHost.create` durable reservation | Not a process lock; durable identity — never swept |
| `run/server.lock` | `DataRootLock` held by the Supervisor itself | **No** — a dead Supervisor can leave an orphan Core; manual inspection stays mandatory |
| `*.recovery` markers | Legacy `recoverStaleOwner` flow | Leftover marker means an interrupted recovery; treated as manual-only evidence, never auto-cleared by this path |

"Full proof" per lock means: file parses as `{pid:int>0, ownerEpoch:string, ...}`, the recorded
`ownerEpoch` belongs to a child this Supervisor spawned, its `installationId` matches the live
install ownership marker, the file's `pid` equals that child's kernel PID, and the record is marked
reaped. Evaluation is **all-or-nothing**: every candidate is judged first; if any refuses, nothing is
unlinked and the launch/startup fails closed. Retirement then re-reads each file and refuses if the
content changed since evaluation (JS cannot exclude a post-check swap; this narrows but does not
eliminate the residual race — see limitations).

## Event order

```text
Supervisor (holds run/server.lock)
  → fork Core gen N (private IPC)
  → Core gen N resolves install identity, reports {pid, ownerEpoch, installationId}
  → Core gen N acquires profile/catalog/target occupancy markers carrying ownerEpoch
  → Host journal accepts command C (durable "accepted", never a completion claim)
  → Supervisor observes gen N child exit/close → marks record reaped
  → Supervisor schedules restart; before launching gen N+1 it scans the managed lock set:
      absent → skip;  proven reaped owner → retire;  anything else → refuse launch
  → Core gen N+1 opens markers fresh, boots held/open, reconciles journals:
      C reads back as execution-unknown; CommandInbox/SessionHost fencing blocks re-dispatch
  → READY published only after the service collection is the single live writer
```

## Commands accepted but never observed completing

`CommandJournal` persists `accepted` receipts; on reopen after a crash they are reported as
`execution-unknown` and `hasUncertainSend()`/admission fencing rejects new sends for that session.
Recovery must never replay an unknown command, manufacture a completion, or treat new service
availability as permission to re-execute work. This change adds no replay path and does not weaken
that invariant; it only removes the occupancy markers of a proven-dead writer.

## Concurrency and crash safety

- `run/server.lock` (`wx` + owner token) serializes Supervisors per data root; the recovery scan runs
  only inside that lock, so at most one trusted Supervisor evaluates a data root.
- The Supervisor launches at most one Core at a time; the scan always runs before `launchCore`,
  while no live Core exists, so a live owner's lock can never be retired by this path (a record whose
  child has not been observed terminated is refused).
- In-process concurrent recovery invocations share a single in-flight scan promise; a file that
  vanished between evaluation and unlink is treated as already retired.
- Supervisor crash mid-scan leaves `run/server.lock` behind: the next Supervisor fails to acquire it
  and the data root stays on the manual path. There is no second marker to leak.
- A Core killed between lock acquire and its `occupancy-owner` report leaves a well-formed file with
  no recorded epoch: fail closed (unverifiable owner → manual). The report is therefore sent as early
  as possible in boot.
- A Core killed while *writing* a lock can leave an empty/partial file: malformed → fail closed.

## Fail-closed matrix (no mutation, operator/manual path)

| Observation | Decision |
| --- | --- |
| Lock file absent | proceed (nothing to recover) |
| `{pid, ownerEpoch}` matches a reaped managed child with matching installationId | retire |
| malformed / unreadable / empty | refuse |
| legacy `{token,pid}` without `ownerEpoch` | refuse (legacy unknown → manual) |
| well-formed record, epoch unknown to this Supervisor | refuse (foreign owner) |
| epoch known but pid differs from the recorded child | refuse (ambiguous/tampered) |
| epoch+pid match but child not observed reaped | refuse (owner may still be alive) |
| installationId mismatch | refuse (different installation) |
| file content changes between evaluation and unlink | refuse |
| a foreign `wx` create interposes after unlink | the new owner's marker is never removed; the next launch attempt fails closed on it |

## Residual limitations (honest scope)

- JS has no atomic compare-and-unlink; between the last read and `unlink` a non-compliant same-UID
  writer could swap the file. Compliant components never remove another's marker, and the
  `server.lock` + single-Core serialization closes the product-internal race.
- Parent `exit`/`close` proves the Core root died and was reaped; it cannot enumerate orphaned
  grandchildren (native CLI workers). Those children are expected to exit on transport close, but
  the supervisor cannot `waitpid` them; until they die, their own journal locks keep their existing
  PID-liveness (ESRCH) refusal, which fails closed at the journal layer. Whole-descendant census is
  not claimed.
- Recovery restores the *writer fence*; it does not certify that durable business state is complete.
  Reconciliation, journal unknown classification and admission fencing remain owned by the services
  layer, unchanged by this file.

## Interfaces

- `contracts.ts` `coreMessageSchema` gains `{type:"occupancy-owner", pid, ownerEpoch,
  installationId}` (child → Supervisor; ignored by older Supervisors, and an old child simply never
  reports → fail closed).
- `@zcode/services/node` exports `getProcessOwnerEpoch()` (per-process random UUID written into
  every occupancy marker) and `getAppConfigDir(dataBaseDir?)` accepts an explicit base dir so the
  Supervisor computes the child's config root from `layout.dataBaseDir` — the same value the
  production launcher exports as `ZCODE_DATA_BASE_DIR`.
- `packages/zcode-server-cli/src/runtime/occupancyRecovery.ts` implements the pure per-lock
  evaluation + two-phase retire; `Supervisor` owns the IPC record table, reap marking and launch
  gating. Recovery refusal at boot aborts `start()`; refusal during crash restart enters
  `stop-failed` with a manual-recovery reason instead of crash-looping.
