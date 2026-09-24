// Child-private scanner: selected values never cross IPC. Traversal rejects symlinks.
import { access, readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";

export async function scanDisposable(dir, forbidden, budget = { files: 0, bytes: 0 }, onFile = () => {}, deadlineAt = Date.now() + 8_000) {
  if (Date.now() >= deadlineAt) throw new Error("private artifact scan timeout");
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await scanDisposable(path, forbidden, budget, onFile, deadlineAt);
    else if (entry.isFile()) {
      if (++budget.files > 1024) throw new Error("private artifact scan budget exceeded");
      if (Date.now() >= deadlineAt) throw new Error("private artifact scan timeout");
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.size > 128 * 1024 * 1024 - budget.bytes)
        throw new Error("private artifact scan budget exceeded");
      const contents = await readFile(path);
      if ((budget.bytes += contents.length) > 128 * 1024 * 1024)
        throw new Error("private artifact scan budget exceeded");
      if (forbidden.some((value) => [
        Buffer.from(value), Buffer.from(value, "utf16le"),
        Buffer.from(encodeURIComponent(value)), Buffer.from(value.replaceAll("/", "\\/")),
      ].some((variant) => variant.length > 0 && contents.includes(variant))))
        throw new Error("private artifact scan failed");
      onFile(budget.files);
    } else throw new Error("private artifact scan unsupported entry");
  }
}

export async function assertAbsent(path) {
  try {
    await access(path);
  } catch {
    return;
  }
  throw new Error("unapproved effect already present");
}
