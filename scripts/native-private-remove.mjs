// Isolated cancellable cleanup worker. Path is disposable root, never printed.
import { rm } from "node:fs/promises";
const root = process.argv[2];
if (process.env.ZCODE_NATIVE_FAKE_HANG_REMOVE === "1") await new Promise(() => setInterval(() => {}, 1000));
if (!root) process.exitCode = 1;
else try { await rm(root, { recursive: true, force: true }); } catch { process.exitCode = 1; }
