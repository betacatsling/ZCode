import { isAbsolute, resolve } from 'node:path';
import { resolvePath } from './file-config.adapter.js';
import { createConfig, type ConfigFactoryOptions, type ConfigResult } from './config-factory.js';

/** Native startup and read-only Node metadata share this exact path interpretation. */
export function resolveConfiguredSessionDbPath(config: ConfigResult, cwd?: string): string {
  const configured = config.config.storage.sessionDbPath;
  if (cwd && !isAbsolute(configured) && !configured.startsWith('~/')) return resolve(cwd, configured);
  return resolvePath(configured);
}

/** Pure path lookup (reads config only); never opens or migrates a session database. */
export function resolveNativeSessionDbPath(
  options: Pick<ConfigFactoryOptions, 'env' | 'userConfigPath' | 'skipUserConfig'> & { cwd: string },
): string {
  const { cwd, ...configOptions } = options;
  // Match protocol bootstrap: config is loaded without project discovery; cwd only anchors relative DB paths.
  return resolveConfiguredSessionDbPath(createConfig({ ...configOptions, suppressDiagnostics: true }), cwd);
}
