# Public share page dependency boundary

The Web package owns the runtime dependency for every library imported directly by its share landing page. `ConversationShareLandingPage.tsx` uses `lucide-react` icons; `@zcode/web` must declare the existing lock-pinned `lucide-react@1.17.0` range in its own `dependencies`, not rely on the UI package or another workspace's node_modules. The pnpm lock Web importer must agree with the package manifest. No UI copy, state, authentication, or rendering behavior changes.

Acceptance: clean isolated frozen-lockfile install with scripts disabled, then root typecheck resolves the Web icon import; root lint and the existing share-page test remain independent gates. A missing direct import must fail rather than be concealed by an ambient/transitive package. This is a metadata-only change: no new state owner or event ordering, and no migration other than reinstalling dependencies from the unchanged pinned lock snapshot.

RED: candidate `22b0545f` isolated Linux frozen install and root typecheck exited 1 at `packages/web/src/share/ConversationShareLandingPage.tsx:11` (TS2307 `lucide-react`); raw log retained under `candidate-22b0545f/jobs/root-typecheck.log`. Existing `packages/ui` importer already pins the same `^1.17.0` / `1.17.0(react@19.2.7)` snapshot. No source or lock change to the old candidate.
