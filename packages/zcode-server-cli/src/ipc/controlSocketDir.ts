import { lstat, mkdir } from "node:fs/promises";
import { dirname, posix } from "node:path";

/**
 * macOS 上 run/control.sock 超过 sun_path 时才使用的短目录。
 *
 * 目录按 uid 隔离，而不是把 socket 直接放进全局可写的 /tmp：同机其他用户可以预测
 * `/tmp/zcode-<hash>.sock` 并抢先创建或监听，造成 Supervisor 起不来或客户端连到冒充者。
 * 服务端创建并校验、客户端连接前校验：必须是本用户拥有、group/other 无权限的真实目录。
 */
const SHORT_SOCKET_DIR_PATTERN = /^\/tmp\/zcode-[0-9]+$/u;

export function shortControlSocketDir(uid: number): string {
  return posix.join("/tmp", `zcode-${uid}`);
}

/** endpoint 位于上面的短目录时返回该目录；run 目录内的 socket 与 Windows pipe 返回 undefined。 */
export function relocatedControlSocketDir(endpoint: string): string | undefined {
  const dir = dirname(endpoint);
  return SHORT_SOCKET_DIR_PATTERN.test(dir) ? dir : undefined;
}

export async function ensurePrivateControlSocketDir(
  dir: string,
  options: { create: boolean },
): Promise<void> {
  if (options.create) await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  const uid = process.getuid?.();
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (uid !== undefined && info.uid !== uid) ||
    (info.mode & 0o077) !== 0
  ) {
    throw new Error(`Control socket directory is not private to the current user: ${dir}`);
  }
}
