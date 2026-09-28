import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExecutionTarget } from "@zcode/shared/agent-host";

const execFile = promisify(execFileCallback);
export const PINNED_CLAUDE_CLI_VERSION = "2.1.263";

export async function resolveClaudeExecutable(explicitPath?: string): Promise<string> {
  const candidates = explicitPath
    ? [explicitPath]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) =>
          join(directory, process.platform === "win32" ? "claude.exe" : "claude"),
        );
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Resolve only the configured executable or entries already present in PATH.
    }
  }
  throw new Error("Claude Code executable was not found in the explicit path or PATH");
}

export async function readClaudeCliVersion(executablePath: string): Promise<string> {
  const scratch = await mkdtemp(
    join(
      process.platform === "win32" ? (process.env.TEMP ?? ".") : "/tmp",
      "zcode-claude-version-",
    ),
  );
  try {
    const { stdout } = await execFile(executablePath, ["--version"], {
      cwd: scratch,
      timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? dirname(executablePath),
        HOME: scratch,
        CLAUDE_CONFIG_DIR: join(scratch, "claude-config"),
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        LANG: "C.UTF-8",
      },
      maxBuffer: 16_384,
    });
    const match = /^([0-9]+\.[0-9]+\.[0-9]+)(?:\s|$)/.exec(stdout.trim());
    if (!match) throw new Error("Claude Code version output is invalid");
    return match[1]!;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function probeClaudeTarget(target: ExecutionTarget, executablePath?: string) {
  if (!target.available)
    return { support: "unsupported" as const, reason: target.reason ?? "target unavailable" };
  if (target.kind !== "local" || target.platform !== process.platform) {
    return {
      support: "unsupported" as const,
      reason: "Claude Code 2.1.263 must run on its local execution target",
    };
  }
  try {
    const executable = await resolveClaudeExecutable(executablePath);
    const version = await readClaudeCliVersion(executable);
    // 版本探针通过只说明 pinned CLI 可执行，不能把控制面能力读成已认证。
    return version === PINNED_CLAUDE_CLI_VERSION
      ? {
          support: "supported" as const,
          reason:
            "Pinned Claude Code CLI version probe succeeded. It does not certify tools, approvals, history, resumeExecution, images, or modelSwitch.",
        }
      : {
          support: "unsupported" as const,
          reason: "Claude Code CLI version is not pinned 2.1.263",
        };
  } catch {
    return {
      support: "unsupported" as const,
      reason: "Pinned Claude Code CLI is unavailable or failed its isolated version check",
    };
  }
}
