# Multi-harness integration assembly (checkpoint)

This checkpoint combines the accepted component sources without mounting the new hierarchy or changing native V4 routing. `@zcode/shared/agent-host` and `@zcode/shared/project-workspaces` remain the wire/type boundaries. The browser-safe `@zcode/services` entrypoint exposes only service contracts; the Node-only entrypoint exposes concrete target/catalog, gateway and transport classes for later composition. `@zcode/ui` exposes the already-tested presentation components for a later host-backed mount. None of these exports installs a second owner or starts an agent.

The profile catalog remains the only writer of presentation metadata, the target worktree service the only writer of Git/generation facts, and the target Host the only writer of accepted external commands. The native V4 owner is unchanged. Composition must supply a real `WorkspaceAdmissionPort`; a missing target authority must fail closed, not authorize a path-based fallback. Gateway tokens must be issued asynchronously against the selected prepared model; use synthetic fixtures until an explicitly authorized live lane is assigned.

```text
future host composition → target worktree admission → Host command journal → adapter → event journal
                   └── profile catalog reads target facts and persisted session summaries
native V4 owner remains separate; no UI/component export changes its event or write path
```

Verification at this checkpoint is source export smoke, focused synthetic component tests, pinned typecheck/lint/architecture; component evidence does not certify production mounting, provider access, migration or remote execution. Root lock must contain the exact `@anthropic-ai/claude-agent-sdk@0.3.263` dependency from `packages/services/package.json`; no temporary SDK installation or credentials may be committed.
