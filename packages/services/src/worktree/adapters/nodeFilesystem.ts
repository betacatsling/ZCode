import { realpath, stat } from "node:fs/promises";
import type { WorktreeFilesystemPort } from "../contract.js";

export const nodeWorktreeFilesystem: WorktreeFilesystemPort = {
  realpath,
  async identity(path) {
    const canonicalPath = await realpath(path);
    const info = await stat(canonicalPath);
    return {
      canonicalPath,
      device: Number.isSafeInteger(info.dev) ? info.dev : null,
      inode: Number.isSafeInteger(info.ino) ? info.ino : null,
      birthtimeMs: Number.isFinite(info.birthtimeMs) ? info.birthtimeMs : null,
    };
  },
};
