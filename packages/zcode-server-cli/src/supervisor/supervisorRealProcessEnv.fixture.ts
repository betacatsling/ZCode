import { join } from "node:path";

/** Test-only process environment for source-paired installed release executables. */
export function isolatedReleaseEnv(
  parent: Pick<NodeJS.ProcessEnv, "NODE_OPTIONS" | "PATH" | "ZCODE_MEMORY_HEAVY_SLOT_OWNER">,
  dir: string,
  provider: string,
): NodeJS.ProcessEnv {
  return {
    // 中文：test runner 的 --require/--import 和私有 workspace .bin 不能进入
    // 已安装 Core/CLI。只保留全局 heavy-slot owner 标记，避免子进程误拿第二把锁。
    NODE_OPTIONS: "--max-old-space-size=2048",
    PATH:
      process.platform === "win32"
        ? "C:\\Windows\\System32;C:\\Windows"
        : "/usr/bin:/bin:/usr/sbin:/sbin",
    ZCODE_MEMORY_HEAVY_SLOT_OWNER: parent.ZCODE_MEMORY_HEAVY_SLOT_OWNER,
    CMAKE_BUILD_PARALLEL_LEVEL: "1",
    GOMAXPROCS: "1",
    RAYON_NUM_THREADS: "1",
    npm_config_child_concurrency: "1",
    npm_config_workspace_concurrency: "1",
    TMPDIR: join(dir, "tmp"),
    HOME: dir,
    XDG_CONFIG_HOME: join(dir, "config"),
    ZCODE_DATA_BASE_DIR: dir,
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: provider,
    ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
    LANG: "C.UTF-8",
  };
}
