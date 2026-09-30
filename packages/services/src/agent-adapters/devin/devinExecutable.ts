import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExecutionTarget } from "@zcode/shared/agent-host";

const execFile = promisify(execFileCallback);

/** Adapter contract version; keep in sync with DEVIN_HARNESS_MANIFEST.adapterVersion. */
export const DEVIN_ADAPTER_VERSION = "0.1.0";

export async function resolveDevinExecutable(explicitPath?: string): Promise<string> {
  const candidates = explicitPath
    ? [explicitPath]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, process.platform === "win32" ? "devin.exe" : "devin"));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Resolve only the configured executable or entries already present in PATH.
    }
  }
  throw new Error("Devin CLI executable was not found in the explicit path or PATH");
}

/** Best-effort version string; Wave 1 does not pin a CLI release yet. */
export async function readDevinCliVersion(executablePath: string): Promise<string> {
  const scratch = await mkdtemp(
    join(process.platform === "win32" ? (process.env.TEMP ?? ".") : "/tmp", "zcode-devin-version-"),
  );
  try {
    const { stdout, stderr } = await execFile(executablePath, ["--version"], {
      cwd: scratch,
      timeout: 10_000,
      env: {
        PATH: process.env.PATH ?? dirname(executablePath),
        HOME: scratch,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        LANG: "C.UTF-8",
      },
      maxBuffer: 16_384,
    });
    const text = `${stdout}\n${stderr}`.trim();
    if (!text) throw new Error("Devin CLI version output is empty");
    return text.split(/\r?\n/, 1)[0]!.trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function probeDevinTarget(target: ExecutionTarget, executablePath?: string) {
  if (!target.available)
    return { support: "unsupported" as const, reason: target.reason ?? "target unavailable" };
  if (target.kind !== "local" || target.platform !== process.platform) {
    return {
      support: "unsupported" as const,
      reason: "Devin CLI must run on its local execution target",
    };
  }
  try {
    const executable = await resolveDevinExecutable(executablePath);
    const version = await readDevinCliVersion(executable);
    return {
      support: "supported" as const,
      reason:
        "Devin CLI answered an isolated version probe; Wave 2 sessions use print mode (-p). Probe support does not certify tools, approvals, history, resume, images, or model switch.",
      constraints: { adapterVersion: DEVIN_ADAPTER_VERSION, cliVersion: version },
    };
  } catch {
    return {
      support: "unsupported" as const,
      reason: "Devin CLI is unavailable or failed its isolated version check",
    };
  }
}
