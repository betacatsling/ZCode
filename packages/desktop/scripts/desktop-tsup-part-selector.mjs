const parts = new Set(["main", "preload", "host", "scheduler"]);

/**
 * @template {{ name?: string }} T
 * @param {readonly T[]} configs
 * @param {string | undefined} part
 * @returns {T[]}
 */
export function selectDesktopTsupConfigs(configs, part) {
  if (part === undefined) return [...configs];
  if (!parts.has(part)) {
    throw new Error("Invalid ZCODE_DESKTOP_BUILD_PART: expected main|preload|host|scheduler");
  }
  const selected = configs.filter((config) => config.name === part);
  if (selected.length !== 1) {
    throw new Error("ZCODE_DESKTOP_BUILD_PART must select exactly one config");
  }
  return selected;
}
