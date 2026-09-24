# pi-file-boundary typed interface (early spec commit 79a4d15bb0e6199420b2b5370aa6dc925e84e16b)

Owner: pi-file-boundary. `packages/services/src/agent-adapters/pi/piFileTools.ts` exports:

```ts
export type PiFileTool = NonNullable<CreateAgentSessionOptions["customTools"]>[number];
export function createPiFileTools(
  root: string,
  hooks?: { afterOpen?: (path: string, mode: "read" | "edit" | "write") => Promise<void> },
): Promise<PiFileTool[]>;
```

Pi worker owner: **must mount before production claim** using the pinned Pi SDK `createAgentSession({ customTools: await createPiFileTools(root), tools: ["read", "write", "edit", "bash"] })` (SDK's custom-tool registry replaces same-name built-ins). `createAgentSession` has no `toolOptions` property in pinned SDK 0.87.1. Do not fall back to SDK default file tools if construction rejects (macOS/Windows and restricted Linux /proc fail closed). Do not pass untrusted CWD as root; verified execution worktree root only. Bash remains unsandboxed. Only file-tool module/spec/capability wording/tests owned here; piWorker integration is pi-canonical's semantic file and NOT edited in this lane. Tests cover Linux inode pin and symlink swap; macOS local test proves failure closed only.

Early SHA: `79a4d15bb0e6199420b2b5370aa6dc925e84e16b`. See `docs/agent-host/PI-FILE-BOUNDARY.md`. Final code SHA follows second commit.
