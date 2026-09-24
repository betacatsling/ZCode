// Disposable fixture only. No real credential value is accepted by this scanner.
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export async function scanDisposable(dir, forbidden, budget = { files: 0, bytes: 0 }) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await scanDisposable(path, forbidden, budget);
    else if (entry.isFile()) {
      if (++budget.files > 1024) throw new Error("private artifact scan budget exceeded");
      const contents = await readFile(path);
      if ((budget.bytes += contents.length) > 128 * 1024 * 1024)
        throw new Error("private artifact scan budget exceeded");
      if (forbidden.some((value) => contents.includes(Buffer.from(value))))
        throw new Error("private artifact scan failed");
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
