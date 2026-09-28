import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import type { SessionSpec } from "@zcode/shared/agent-host";

const PROFILE_MARKER = "zcode-managed-claude-session-profile";
const effortLevels = new Set(["low", "medium", "high", "xhigh", "max"]);

export interface ClaudeSessionProfile {
  readonly root: string;
  readonly home: string;
  readonly configDir: string;
  readonly runtimeTmp: string;
  readonly cwd: string;
  readonly settingsPath: string;
  readonly helperPath: string;
  readonly capabilityPath: string;
  readonly gatewayBaseUrl: string;
  readonly modelAlias: string;
  readonly effort: string;
  readonly maxOutputTokens: number;
}

export function claudeSessionProfileRoot(root: string, spec: SessionSpec): string {
  const identity = [
    spec.execution.targetId,
    spec.execution.workspaceIdentity,
    spec.harness.id,
    spec.hostSessionId,
  ];
  return join(root, createHash("sha256").update(JSON.stringify(identity)).digest("hex"));
}

export async function prepareClaudeSessionProfile(input: {
  readonly root: string;
  readonly spec: SessionSpec;
  readonly gatewayBaseUrl: string;
  readonly gatewayToken: string;
  readonly hookUrl: string;
  readonly modelAlias: string;
  readonly effort: string;
  readonly maxOutputTokens: number;
}): Promise<ClaudeSessionProfile> {
  validateLoopbackUrl(input.gatewayBaseUrl, "Model Gateway");
  validateLoopbackUrl(input.hookUrl, "PreToolUse hook");
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(input.modelAlias))
    throw new Error("Claude Model Gateway alias is invalid");
  if (!effortLevels.has(input.effort)) throw new Error("Claude effort is not supported");
  if (!Number.isSafeInteger(input.maxOutputTokens) || input.maxOutputTokens < 1)
    throw new Error("Claude output-token limit is invalid");

  const profileRoot = claudeSessionProfileRoot(input.root, input.spec);
  const home = join(profileRoot, "home");
  const configDir = join(profileRoot, "claude-config");
  const runtimeTmp = join(profileRoot, "runtime-tmp");
  for (const directory of [profileRoot, home, configDir, runtimeTmp]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") await chmod(directory, 0o700);
  }
  const settingsPath = join(configDir, "settings.json");
  const helperPath = join(configDir, "zcode-api-key-helper.mjs");
  const capabilityPath = join(configDir, "gateway-session-capability");
  const helper = [
    "#!/usr/bin/env node",
    `// ${PROFILE_MARKER}`,
    'import { readFileSync } from "node:fs";',
    `try { process.stdout.write(readFileSync(${JSON.stringify(capabilityPath)}, "utf8")); } catch { process.exit(2); }`,
    "",
  ].join("\n");
  await writeManagedFile(helperPath, helper, 0o700, PROFILE_MARKER);
  await writeManagedFile(settingsPath, JSON.stringify({
    apiKeyHelper: helperPath,
    env: { ZCODE_MANAGED_PROFILE: PROFILE_MARKER },
    enabledPlugins: {},
    sandbox: {
      enabled: false,
      allowUnsandboxedCommands: true,
      failIfUnavailable: false,
    },
    hooks: {
      PreToolUse: [
        {
          matcher: "",
          hooks: [{ type: "http", url: input.hookUrl, timeout: 600 }],
        },
      ],
    },
  }), 0o600, PROFILE_MARKER);
  await writeClaudeSessionCapability(capabilityPath, input.gatewayToken);
  return {
    root: profileRoot,
    home,
    configDir,
    runtimeTmp,
    cwd: input.spec.execution.worktreePath,
    settingsPath,
    helperPath,
    capabilityPath,
    gatewayBaseUrl: input.gatewayBaseUrl,
    modelAlias: input.modelAlias,
    effort: input.effort,
    maxOutputTokens: input.maxOutputTokens,
  };
}

export async function writeClaudeSessionCapability(path: string, token: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new Error("Claude session capability is invalid");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(token, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export function createClaudeChildEnvironment(input: {
  readonly profile: ClaudeSessionProfile;
  readonly executablePath: string;
}): NodeJS.ProcessEnv {
  const pathEntries = [
    dirname(input.executablePath),
    "/usr/bin",
    "/bin",
    ...(process.env.PATH ? process.env.PATH.split(delimiter) : []),
  ];
  const path = [...new Set(pathEntries.filter(Boolean))].join(delimiter);
  const env: NodeJS.ProcessEnv = {
    PATH: path,
    HOME: input.profile.home,
    XDG_CONFIG_HOME: join(input.profile.home, ".config"),
    XDG_CACHE_HOME: join(input.profile.home, ".cache"),
    XDG_DATA_HOME: join(input.profile.home, ".local", "share"),
    CLAUDE_CONFIG_DIR: input.profile.configDir,
    ANTHROPIC_BASE_URL: input.profile.gatewayBaseUrl,
    CLAUDE_CODE_EFFORT_LEVEL: input.profile.effort,
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(input.profile.maxOutputTokens),
    CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
    // Scrub=1 forces Linux sandbox even when settings.sandbox.enabled is false
    // (CLI: Bu()&&!IU() → PO()). Bridge sockets fail on this box, so opt out.
    CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "0",
    MAX_THINKING_TOKENS: "0",
    CLAUDE_CODE_DISABLE_THINKING: "1",
    DISABLE_PROMPT_CACHING: "1",
    DISABLE_INTERLEAVED_THINKING: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    DISABLE_BUG_COMMAND: "1",
    DISABLE_AUTOUPDATER: "1",
    ENABLE_CLAUDEAI_MCP_SERVERS: "false",
    TMPDIR: input.profile.runtimeTmp,
    TMP: input.profile.runtimeTmp,
    TEMP: input.profile.runtimeTmp,
    LANG: "C.UTF-8",
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

export function createClaudeArguments(input: {
  readonly executablePath: string;
  readonly profile: ClaudeSessionProfile;
  readonly nativeSessionId: string;
  readonly resume: boolean;
  readonly tools: readonly string[];
}): string[] {
  const args = [
    "--print",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--include-hook-events",
    "--model",
    input.profile.modelAlias,
    "--effort",
    input.profile.effort,
    "--permission-mode",
    "default",
    "--permission-prompts",
    "none",
    "--setting-sources",
    "user",
    "--settings",
    input.profile.settingsPath,
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--tools",
    input.tools.join(","),
  ];
  if (input.resume) args.push("--resume", input.nativeSessionId);
  else args.push("--session-id", input.nativeSessionId);
  return args;
}

async function writeManagedFile(
  path: string,
  contents: string,
  mode: number,
  marker: string,
): Promise<void> {
  try {
    const current = await readFile(path, "utf8");
    if (!current.includes(marker)) throw new Error("refusing to overwrite an unmanaged Claude profile file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  if (!contents.includes(marker)) throw new Error("managed Claude file marker is missing");
}

function validateLoopbackUrl(value: string, label: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error(`${label} must use an unauthenticated loopback URL`);
  }
}
