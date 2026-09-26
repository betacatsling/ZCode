PRODUCT_SHELL_JOIN_GATE: FAIL

# No-delegation correction-pass audit (not an independent reviewer)

At clean source commit `4719b11`, root `pnpm typecheck` now passes under the required shared 2 GiB slot. The runner preserves the original 11 root TS projects and derives the full reference closure from the checked-out configs; it invokes installed `tsc -b` via `process.execPath` serially without reducing compiler options. Six tests pass, including malformed/missing/cyclic graph, signaled/failed compiler, a real TS2322 negative and a changed-source stale-declaration negative. Targeted format, root lint (0 errors/76 warnings) and architecture (0 new/0 baseline) pass. Prior single-process `tsc -b` OOM remains historical evidence, not the current result.

Fresh finite runs on this checkout: real default Core→one-use ticketed RPC Git import/adopt and restart plus factory **2/2** (`/tmp/product-join-final-core.log`); canonical producer/renderer paging **23/23** (`/tmp/product-join-final-history.log`); production Host 100k synthetic journal/rows **5/5** (`/tmp/product-join-final-host-history.log`); desktop/mobile direct Playwright controlled Shell **42/42** (`/tmp/product-join-final-browser.log`). Fixtures dispose attachments and wait for Core child closes; after tests, process inspection found zero matching owned Core and Vite fixtures. No paid network, credentials, global settings or push. The last independent reviewer file is `.tmp/REVIEW-product-shell-join-1.md` and was preserved verbatim in `d064dbe`; no new independent reviewer was delegated, as requested.

**Product gap unchanged:** `packages/ui/e2e/shell-pane.fixture.tsx` supplies controlled renderer services/snapshots; no actual browser WebSocket attachment can present the one-use `/ws/host` capability header required by `packages/zcode-server-cli/src/server-core/http.ts` and no reviewed browser/window bridge exists. Generic `/ws` is correctly denied Host/Catalog/hierarchy. `mountLocalCore` in `packages/desktop/src/host/targetCoreMount.ts` exercises Node desktop attachment, not a browser viewport. No test actually sends a prompt through real Core→Shell→Pi worker with an existing Model bound to isolated localhost fake HTTP; no two same-worktree live agents, active-stream detached owner, real measured Model usage through Shell, mobile replayable Core recovery, or Core-mounted far-old mutation/browse >2000. No renderer-services substitute or unauthenticated route was added to manufacture a PASS. Native creation remains fail-closed; separate CLI durable receipt/new ID mapping and Core native ownership remain outside this lane. Packaged Electron, SSH, load and 8h are unclaimed.

```text
Git Target receipt → Catalog workspace → Host admitted session + journal (single authority)
                                     → one-use authenticated RPC attachment → Shell window/cursor/draft
                         detach ────→ Host continues; no prompt replay
                  desktop-continuous / web-replayable → same owner, different recovery contracts
```

To close the scoped gate, supply an owner-reviewed authenticated browser/window attachment exposing the actual Core services through existing public RPC and platform abstraction (not renderer replacement objects), then run finite isolated fake-localhost-Model Pi create/send/split/stream/detach/rejoin/usage with exact identity/command/owner assertions, and repeat long-history browse while streaming through that mounted Core. Independent new review must rerun that proof; this self-audit is not it.
