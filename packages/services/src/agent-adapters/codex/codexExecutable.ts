import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const PINNED_CODEX_CLI_VERSION = "codex-cli 0.157.1";

/** Read the version with an isolated home so a probe never loads a personal Codex profile. */
export async function readCodexCliVersion(executablePath: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zcode-codex-version-"));
  const home = join(root, "home");
  const codexHome = join(root, "codex-home");
  const runtimeTmp = join(root, "runtime-tmp");
  await Promise.all(
    [home, codexHome, runtimeTmp].map((path) => mkdir(path, { recursive: true, mode: 0o700 })),
  );
  try {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? dirname(executablePath),
      HOME: home,
      CODEX_HOME: codexHome,
      TMPDIR: runtimeTmp,
      TMP: runtimeTmp,
      TEMP: runtimeTmp,
      XDG_RUNTIME_DIR: runtimeTmp,
      LANG: process.env.LANG ?? "C.UTF-8",
    };
    if (process.platform === "win32") {
      for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const) {
        if (process.env[key]) env[key] = process.env[key];
      }
    }
    const result = await execFileAsync(executablePath, ["--version"], {
      cwd: root,
      env,
      maxBuffer: 4096,
    });
    return result.stdout.trim();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
