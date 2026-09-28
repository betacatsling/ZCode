import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import type { SessionSpec } from "@zcode/shared/agent-host";

export interface CodexSessionProfile {
  readonly root: string;
  readonly home: string;
  readonly codexHome: string;
  readonly runtimeTmp: string;
  readonly cwd: string;
  readonly configPath: string;
}

export type CodexSandboxMode = "workspace-write" | "danger-full-access";
export interface CodexApprovalPolicy {
  readonly granular: {
    readonly mcp_elicitations: boolean;
    readonly rules: boolean;
    readonly sandbox_approval: boolean;
  };
}

export const HOST_APPROVAL_POLICY: CodexApprovalPolicy = {
  granular: { mcp_elicitations: false, rules: true, sandbox_approval: true },
};

const PROFILE_MARKER = "# Managed isolated ZCode Codex session profile.";
const GATEWAY_TOKEN_ENV = "ZCODE_CODEX_GATEWAY_TOKEN";

export function resolveCodexExecutable(explicitPath?: string): Promise<string> {
  const candidates = explicitPath
    ? [explicitPath]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((directory) => join(directory, process.platform === "win32" ? "codex.exe" : "codex"));
  return findExecutable(candidates);
}

export function codexSessionProfileRoot(root: string, spec: SessionSpec): string {
  const identity = [
    spec.execution.targetId,
    spec.execution.workspaceIdentity,
    spec.harness.id,
    spec.hostSessionId,
  ];
  return join(root, createHash("sha256").update(JSON.stringify(identity)).digest("hex"));
}

async function findExecutable(candidates: readonly string[]): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the explicitly supplied path or PATH entries only.
    }
  }
  throw new Error("Codex CLI executable was not found in the explicit path or PATH");
}

export function createCodexChildEnvironment(input: {
  executablePath: string;
  profile: CodexSessionProfile;
  gatewayToken: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? dirname(input.executablePath),
    HOME: input.profile.home,
    CODEX_HOME: input.profile.codexHome,
    TMPDIR: input.profile.runtimeTmp,
    TMP: input.profile.runtimeTmp,
    TEMP: input.profile.runtimeTmp,
    XDG_RUNTIME_DIR: input.profile.runtimeTmp,
    LANG: process.env.LANG ?? "C.UTF-8",
    [GATEWAY_TOKEN_ENV]: input.gatewayToken,
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

export async function prepareCodexSessionProfile(input: {
  root: string;
  spec: SessionSpec;
  gatewayBaseUrl: string;
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  shellPath: string;
}): Promise<CodexSessionProfile> {
  const gatewayUrl = new URL(input.gatewayBaseUrl);
  if (
    gatewayUrl.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(gatewayUrl.hostname) ||
    gatewayUrl.username ||
    gatewayUrl.password
  ) {
    throw new Error("Codex profile requires a loopback-only Model Gateway URL");
  }
  const profileRoot = codexSessionProfileRoot(input.root, input.spec);
  const home = join(profileRoot, "home");
  const codexHome = join(profileRoot, "codex-home");
  const runtimeTmp = join(profileRoot, "runtime-tmp");
  for (const directory of [profileRoot, home, codexHome, runtimeTmp]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
  }
  for (const directory of [
    ".tmp",
    "sessions",
    "shell_snapshots",
    "skills",
    "thread-writer-locks",
    "tmp",
  ]) {
    const path = join(codexHome, directory);
    await mkdir(path, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(path, 0o700);
  }
  const configPath = join(codexHome, "config.toml");
  const config = createConfig(gatewayUrl.origin, input.sandboxMode, input.approvalPolicy, {
    shellPath: input.shellPath,
    home,
    codexHome,
    runtimeTmp,
  });
  await writeIsolatedConfig(configPath, config);
  return {
    root: profileRoot,
    home,
    codexHome,
    runtimeTmp,
    cwd: input.spec.execution.worktreePath,
    configPath,
  };
}

async function writeIsolatedConfig(path: string, contents: string): Promise<void> {
  try {
    const current = await readFile(path, "utf8");
    if (!current.startsWith(PROFILE_MARKER)) {
      throw new Error("refusing to overwrite an unmanaged Codex profile config");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

function createConfig(
  gatewayUrl: string,
  sandboxMode: CodexSandboxMode,
  approvalPolicy: CodexApprovalPolicy,
  environment: { shellPath: string; home: string; codexHome: string; runtimeTmp: string },
): string {
  return [
    PROFILE_MARKER,
    'model = "zcode-host"',
    'model_provider = "zcode"',
    'model_reasoning_effort = "none"',
    `approval_policy = ${approvalPolicyToml(approvalPolicy)}`,
    `sandbox_mode = ${JSON.stringify(sandboxMode)}`,
    "allow_login_shell = false",
    'web_search = "disabled"',
    "",
    "[features]",
    "apps = false",
    "multi_agent = false",
    "remote_plugin = false",
    "plugins = false",
    "shell_snapshot = false",
    "",
    "[shell_environment_policy]",
    'inherit = "none"',
    "ignore_default_excludes = false",
    `set = { PATH = ${JSON.stringify(environment.shellPath)}, HOME = ${JSON.stringify(environment.home)}, CODEX_HOME = ${JSON.stringify(environment.codexHome)}, TMPDIR = ${JSON.stringify(environment.runtimeTmp)}, TMP = ${JSON.stringify(environment.runtimeTmp)}, TEMP = ${JSON.stringify(environment.runtimeTmp)} }`,
    `exclude = [${JSON.stringify(GATEWAY_TOKEN_ENV)}]`,
    "",
    "[model_providers.zcode]",
    'name = "ZCode session-local Model Gateway"',
    `base_url = ${JSON.stringify(`${gatewayUrl}/v1`)}`,
    `env_key = ${JSON.stringify(GATEWAY_TOKEN_ENV)}`,
    'wire_api = "responses"',
    "",
  ].join("\n");
}

function approvalPolicyToml(policy: CodexApprovalPolicy): string {
  const { mcp_elicitations, rules, sandbox_approval } = policy.granular;
  return `{ granular = { mcp_elicitations = ${mcp_elicitations}, rules = ${rules}, sandbox_approval = ${sandbox_approval} } }`;
}
