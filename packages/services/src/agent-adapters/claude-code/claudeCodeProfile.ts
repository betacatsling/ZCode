import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { SessionSpec } from "@zcode/shared/agent-host";
import { ClaudeCodeAdapterError } from "./claudeCodeErrors.js";

export interface ClaudeCodeProfilePlan {
  readonly configDir: string;
  readonly homeDir: string;
  readonly markerPath: string;
  readonly marker: string;
}

export interface ClaudeCodeProfileSink {
  writeMarker(path: string, body: string): Promise<void>;
  removeProfile(configDir: string): Promise<void>;
}

/** Identity key matches the host rule: trimmed workspaceIdentity, else the worktree path. */
export function claudeCodeWorkspaceKey(spec: SessionSpec): string {
  const identity = spec.execution.workspaceIdentity.trim();
  return identity || spec.execution.worktreePath;
}

export function isInsidePath(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/** User-global Claude login directories are never a valid managed profile location. */
export function isUserClaudeConfigPath(candidate: string, userHome: string): boolean {
  const roots = [resolve(userHome, ".claude"), resolve(userHome, ".config", "claude")];
  return roots.some((root) => isInsidePath(root, candidate));
}

export function assertIsolatedClaudeCodePath(candidate: string, userHome: string): void {
  if (isUserClaudeConfigPath(candidate, userHome)) {
    throw new ClaudeCodeAdapterError(
      "unsupported",
      "Refusing to read or write Claude global login configuration",
    );
  }
}

export function planClaudeCodeProfile(input: {
  readonly managedRoot: string;
  readonly userHome: string;
  readonly spec: SessionSpec;
  readonly env?: NodeJS.ProcessEnv;
}): ClaudeCodeProfilePlan {
  assertIsolatedClaudeCodePath(input.managedRoot, input.userHome);
  const hash = createHash("sha256")
    .update(
      [input.spec.execution.targetId, claudeCodeWorkspaceKey(input.spec), input.spec.hostSessionId].join(
        "\0",
      ),
    )
    .digest("hex");
  const configDir = resolve(input.managedRoot, "profiles", hash, "config");
  const homeDir = resolve(input.managedRoot, "profiles", hash, "home");
  const markerPath = resolve(configDir, "zcode-claude-code-profile.json");
  assertIsolatedClaudeCodePath(configDir, input.userHome);
  assertIsolatedClaudeCodePath(homeDir, input.userHome);
  assertIsolatedClaudeCodePath(markerPath, input.userHome);
  const delegated = input.env?.CLAUDE_CONFIG_DIR;
  if (delegated && [configDir, homeDir, markerPath].some((path) => resolve(path) === resolve(delegated))) {
    throw new ClaudeCodeAdapterError("unsupported", "Refusing to reuse CLAUDE_CONFIG_DIR");
  }
  const marker = JSON.stringify({
    managedBy: "zcode-claude-code-adapter",
    hostSessionId: input.spec.hostSessionId,
    isolatesGlobalClaudeLogin: true,
  });
  const apiKey = input.env?.ANTHROPIC_API_KEY;
  if (apiKey && marker.includes(apiKey)) {
    throw new ClaudeCodeAdapterError("unsupported", "Profile marker must not contain API keys");
  }
  return { configDir, homeDir, markerPath, marker };
}

export function createFilesystemClaudeCodeProfileSink(input: {
  readonly managedRoot: string;
  readonly userHome: string;
}): ClaudeCodeProfileSink {
  const guard = (candidate: string) => {
    assertIsolatedClaudeCodePath(candidate, input.userHome);
    if (!isInsidePath(input.managedRoot, candidate)) {
      throw new ClaudeCodeAdapterError("unsupported", "Claude Code profile escaped the managed root");
    }
  };
  return {
    async writeMarker(path, body) {
      guard(path);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
    },
    async removeProfile(configDir) {
      guard(configDir);
      await rm(resolve(configDir, ".."), { recursive: true, force: true });
    },
  };
}
