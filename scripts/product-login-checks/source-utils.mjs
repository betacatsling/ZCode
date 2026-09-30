import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
export const CLI_SRC = join(ROOT, "apps/zcode-cli/packages/cli/src");
export const LOGIN = join(CLI_SRC, "login-command.ts");
export const TUI_AUTH = join(CLI_SRC, "tui-auth.ts");
export const CREATE = join(CLI_SRC, "command-center/create.ts");
export const CHANNELS = join(ROOT, "packages/shared/src/channels.ts");
export const PLATFORM = join(ROOT, "packages/shared/src/platform.ts");
export const UI_SRC = join(ROOT, "packages/ui/src");

function listSourceFiles(dir, extensions, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      listSourceFiles(full, extensions, acc);
    } else if (extensions.some((ext) => name.endsWith(ext))) {
      acc.push(full);
    }
  }
  return acc;
}

export function grepFiles(dir, pattern, { extensions = [".ts", ".tsx", ".mjs", ".js"] } = {}) {
  const hits = [];
  for (const file of listSourceFiles(dir, extensions)) {
    let src;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = [];
    const split = src.split(/\r?\n/);
    for (let i = 0; i < split.length; i++) {
      if (pattern.test(split[i])) {
        lines.push({ line: i + 1, text: split[i].trim().slice(0, 160) });
      }
      // reset lastIndex for global patterns
      pattern.lastIndex = 0;
    }
    if (lines.length) {
      hits.push({
        file: relative(ROOT, file),
        matches: lines.slice(0, 8),
        matchCount: lines.length,
      });
    }
  }
  return hits;
}
