import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { GitExecResult, WorktreeGitExecPort } from "../contract.js";

const execFile = promisify(execFileCallback);

export const nodeWorktreeGitExec: WorktreeGitExecPort = {
  async run(args): Promise<GitExecResult> {
    try {
      const result = await execFile("git", [...args], {
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: 0 };
    } catch (error) {
      const failure = error as NodeJS.ErrnoException & {
        stdout?: string;
        stderr?: string;
        code?: number | string;
      };
      return {
        stdout: failure.stdout ?? "",
        stderr: failure.stderr ?? failure.message ?? "",
        exitCode: typeof failure.code === "number" ? failure.code : 1,
      };
    }
  },
};
