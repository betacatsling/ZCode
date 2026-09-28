# Live validation environment (redacted)

Date: 2026-09-27. This document records preparation evidence for the P3 live
Pi route check. It contains no endpoint, key, header, account identity or user
session data.

## Isolated targets

| Target         | Evidence                                                                                     | Isolated location                       |
| -------------- | -------------------------------------------------------------------------------------------- | --------------------------------------- |
| local Linux    | Node 24.14.0 / pnpm 10.33.2 validation toolchain; existing worktree                          | temporary test directories under `/tmp` |
| macOS target-1 | macOS 27.0, arm64, Git 2.50.1; Node 26.8.1 and mise 2026.9.12 found outside the default PATH | `/tmp/zcode-live-env.dvTxmq`            |

The selected Mac source copy was synchronized from the current checkout and
then reconciled with two incremental rsync passes because other workspace
agents were still adding source files during the first long transfer. The copy
contains the source tree and current uncommitted implementation, while these
were excluded: `.git`, `node_modules`, `.pi`, `.worktrees`, every `.env*`
file, key/certificate files and logs. No ZCode user data root was found on the
Mac. Dependencies were installed only inside the isolated copy with
`pnpm install --frozen-lockfile`; the resulting `node_modules` is not part of
the source transfer.

The Mac toolchain was run through the existing mise installation without
changing the default shell or global version: `mise exec -- node --version`
reported `v24.14.0`, and `mise exec -- pnpm --version` reported `10.33.2`.
The isolated copy passed typecheck, built the server CLI and Pi worker bundle,
initialized the packaged Pi worker with an isolated configuration and no
Provider credential, and passed the Agent Host/UI deterministic suite (50/50)
and lint (0 errors, 70 warnings). These checks do not certify a live Provider.

## Provider metadata

The local and Mac `~/.pi/agent/models.json` files contain `stepfun` and
`axonhub` entries with configured authentication fields. The selected StepFun
model is `step-3.5-flash`; the selected AxonHub candidate is
`deepseek-v4-flash`. Preparation read only provider/model IDs, configured
limits and authentication-presence facts. During the explicitly authorized
native runs, the selected Provider entry was read into process memory and
materialized only in a mode-0600 temporary Provider Config. Credentials were
not copied to the repository, user configuration or logs.

StepFun estimates use USD 0.10/M input and USD 0.30/M output with an explicit
planning conversion of ¥8/USD; these are not billing receipts or a spending
ceiling. The official StepFun pricing page was unavailable to the browser and
direct read-only fetch in this environment. AxonHub's configured proxy has no
independently verifiable public rate card; DeepSeek's official origin price
cannot be assumed to be AxonHub's price. The latest user instruction permits
minimal necessary AxonHub calls without a monetary hard cap and requires that
no price be guessed.

The earlier Pi StepFun certification passed on local Linux and the isolated
Mac, with no credentials copied between them; its counts and estimates remain
in `LIVE-CERTIFICATION.md`. The latest native Linux StepFun attempt used fixed
Node `v24.14.0`, recorded 12 runtime model attempts and known aggregate usage,
then failed the ten-attempt acceptance limit before follow-up. No more
StepFun call was made. The one native Linux AxonHub attempt used the existing
SSH configuration to read only the selected literal Provider entry into
private process memory. It recorded six runtime attempts and 13,216 input /
770 output tokens, but the fixture could not confirm its required successful
`node check.mjs` tool row and therefore did not send a follow-up. Its fetch
audit observed six HTTP responses and one outcome unknown at stop. A later
offline fake-route run exposed that the audit writer could lose an entry at a
stop boundary; the pre-send audit now flushes before fetch, and the fixed fake
route passes. The AxonHub request was not repeated, so its physical-send count
remains unknown. No live native permission-denial control or
GUI/persistence/SSH-reconnect test passed in this batch.

## Native matrix toolchain evidence

The Mac native matrix used `/opt/homebrew/bin/mise exec` with Node `24.14.0`
and pnpm `10.33.2`; the noninteractive SSH shell did not expose `mise` until
that explicit path was used. Linux's default PATH reports Node `24.18.1`, but
the fixed Node `24.14.0` toolchain is installed at
`/tmp/zcode-toolchain.E7bW9N/node_modules/.bin` with pnpm `10.33.2`. The
earlier claim that Node 24.14.0 was unavailable on Linux was incorrect. The
Linux native fake route was rerun through that toolchain and passed with seven
loopback model requests, nine history rows, and CLI artifact SHA-256
`a62d891f89abb2d78bd1b24387b441e82d02aa32fc460c3c6d613beed58104a7`.

The workspace freshness command was attempted before validation but could not
complete because its `git fetch origin --prune` step could not write the
read-only `.git/FETCH_HEAD`. `git status` remained readable and was used to
preserve the existing worktree state.

The native fake and real fixtures use only per-run temporary `HOME`,
`ZCODE_DATA_BASE_DIR`, personal Provider Config and worktree directories.
