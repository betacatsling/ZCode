import { spawn } from "node:child_process";
import { join } from "node:path";

// The removal worker is the only writer to this disposable tree during teardown.
// A failed reap must never be interpreted as a successful removal.
export async function removeBounded(
  disposable,
  deadlineAt,
  { rootDir, hang = false, launch = spawn } = {},
) {
  const child = launch(
    process.execPath,
    [join(rootDir, "scripts/native-private-remove.mjs"), disposable],
    {
      stdio: "ignore",
      env: {
        PATH: process.env.PATH,
        HOME: disposable,
        ...(hang ? { ZCODE_NATIVE_FAKE_HANG_REMOVE: "1" } : {}),
      },
    },
  );
  let finish;
  const exited = new Promise((resolve) => {
    finish = resolve;
  });
  child.once("error", () => finish({ code: null, signal: "error" }));
  child.once("exit", (code, signal) => finish({ code, signal }));
  child.once("close", (code, signal) => finish({ code, signal }));
  async function until(time) {
    let timer;
    try {
      return await Promise.race([
        exited,
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), Math.max(1, time - Date.now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const first = await until(deadlineAt - 1000);
  if (first) return first.code === 0 && !first.signal;
  // 修复：SIGKILL 之后也可能没有 exit 通知；不可再无限 await exited。
  child.kill("SIGKILL");
  await until(deadlineAt);
  return false;
}
