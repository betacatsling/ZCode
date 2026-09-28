import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZCodeProtocolClient } from "../../src/zcode-agent/zcodeProtocolClient.js";

export interface ChildCloseResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface ChildCleanupResult extends ChildCloseResult {
  readonly normal: boolean;
  readonly forcedTermination: NodeJS.Signals | null;
  readonly transportCleanupError?: string;
}

export interface FixtureChild {
  readonly process: ChildProcessWithoutNullStreams;
  readonly pid: number;
  readonly close: Promise<ChildCloseResult>;
}

export function fakeNativeChildEnvironment(options: {
  readonly home: string;
  readonly dataBaseDir: string;
  readonly builtinConfigPath: string;
  readonly personalConfigPath: string;
  readonly fetchGuardOptions: string;
  readonly fetchAuditPath: string;
}): NodeJS.ProcessEnv {
  // 原因：继承宿主 Provider 环境可能绕过 fake 配置；子进程只收到执行所需的非凭据变量。
  return {
    PATH: process.env.PATH ?? process.env.Path ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
    ...(process.env.COMSPEC ? { COMSPEC: process.env.COMSPEC } : {}),
    ...(process.env.PATHEXT ? { PATHEXT: process.env.PATHEXT } : {}),
    ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    HOME: options.home,
    USERPROFILE: options.home,
    APPDATA: join(options.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(options.home, "AppData", "Local"),
    TMPDIR: tmpdir(),
    TMP: tmpdir(),
    TEMP: tmpdir(),
    NODE_ENV: "test",
    ZCODE_DATA_BASE_DIR: options.dataBaseDir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: options.builtinConfigPath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: options.personalConfigPath,
    NODE_OPTIONS: options.fetchGuardOptions,
    ZCODE_NATIVE_FETCH_GUARD_LOG: options.fetchAuditPath,
    HTTP_PROXY: "",
    http_proxy: "",
    HTTPS_PROXY: "",
    https_proxy: "",
    ALL_PROXY: "",
    all_proxy: "",
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
  };
}

function waitWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<undefined>((resolvePromise) => {
      timer = setTimeout(() => resolvePromise(undefined), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

export function spawnNativeFixtureChild(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): FixtureChild {
  const child = spawn(command, [...args], {
    ...options,
    stdio: ["pipe", "pipe", "pipe"],
    detached: false,
  });
  if (!Number.isSafeInteger(child.pid)) throw new Error("native fixture child has no PID");
  const pid = child.pid!;
  const close = new Promise<ChildCloseResult>((resolvePromise) => {
    child.once("close", (exitCode, signal) => resolvePromise({ exitCode, signal }));
  });
  return { process: child, pid, close };
}

export async function cleanupNativeFixtureChild(
  owned: FixtureChild,
  client: ZCodeProtocolClient | undefined,
): Promise<ChildCleanupResult> {
  let transportCleanupError: string | undefined;
  if (client) {
    try {
      await client.disposeAndWait();
    } catch (error) {
      transportCleanupError = error instanceof Error ? error.message : String(error);
    }
  }
  let closed = await waitWithin(owned.close, 8_000);
  let forcedTermination: NodeJS.Signals | null = null;
  if (
    !closed &&
    owned.process.exitCode === null &&
    owned.process.signalCode === null &&
    owned.process.pid === owned.pid
  ) {
    forcedTermination = "SIGTERM";
    owned.process.kill(forcedTermination);
    closed = await waitWithin(owned.close, 3_000);
  }
  if (
    !closed &&
    owned.process.exitCode === null &&
    owned.process.signalCode === null &&
    owned.process.pid === owned.pid
  ) {
    forcedTermination = "SIGKILL";
    owned.process.kill(forcedTermination);
    closed = await waitWithin(owned.close, 3_000);
  }
  if (!closed) {
    return {
      exitCode: owned.process.exitCode,
      signal: owned.process.signalCode,
      normal: false,
      forcedTermination,
      transportCleanupError:
        transportCleanupError ?? `fixture-owned native CLI child ${owned.pid} did not exit`,
    };
  }
  return {
    ...closed,
    normal:
      forcedTermination === null &&
      transportCleanupError === undefined &&
      closed.exitCode === 0 &&
      closed.signal === null,
    forcedTermination,
    ...(transportCleanupError ? { transportCleanupError } : {}),
  };
}
