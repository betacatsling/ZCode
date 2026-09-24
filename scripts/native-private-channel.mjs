import { spawn } from "node:child_process";

// Registered at spawn, not inside finally: signal exits have null exitCode and exit may have fired.
export function openPrivateChannel(command, args, options, onMessage) {
  const child = spawn(command, args, options);
  const frames = [];
  let queuedBytes = 0;
  let line = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stopped = false;
  let closing = false;
  let wake;
  let reason;
  let exitResult;
  let finishExit;
  const exited = new Promise((resolve) => { finishExit = resolve; });
  function fail(message) {
    if (!reason) reason = new Error(message);
    stopped = true;
    wake?.(); wake = undefined;
  }
  child.on("error", () => { fail("private spawn/IPC error"); finishExit?.({ code: null, signal: "error" }); finishExit = undefined; });
  child.on("exit", (code, signal) => { exitResult = { code, signal }; finishExit?.(exitResult); finishExit = undefined; fail("private child exited"); });
  child.on("close", (code, signal) => { exitResult ??= { code, signal }; finishExit?.(exitResult); finishExit = undefined; fail("private child closed"); });
  child.on("disconnect", () => { if (!closing) fail("private child IPC disconnected"); });
  child.on("message", (message) => { try { onMessage(message); } catch { fail("private IPC counter mismatch"); } });
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (line.length + chunk.length + queuedBytes > 2_097_152 || chunk.length + line.length > 1_048_576) {
      fail("private stdout byte budget"); child.kill(); return;
    }
    const bytes = Buffer.concat([line, chunk]);
    let start = 0;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) {
      const piece = bytes.subarray(start, i);
      if (piece.length > 1_048_576 || frames.length >= 128) { fail("private frame budget"); child.kill(); return; }
      try { frames.push({ frame: JSON.parse(piece.toString("utf8")), bytes: piece.length }); }
      catch { fail("private frame malformed"); child.kill(); return; }
      queuedBytes += piece.length;
      start = i + 1;
    }
    line = Buffer.from(bytes.subarray(start));
    wake?.(); wake = undefined;
  });
  child.stdout.on("end", () => { if (line.length) fail("private truncated frame"); else if (!closing) fail("private unexpected EOF"); });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > 1_048_576) { fail("private stderr byte budget"); child.kill(); }
  });
  child.stdin.on("error", () => fail("private stdin failed"));
  return {
    child, exited,
    get exitResult() { return exitResult; },
    get outputBytes() { return { stdoutBytes, stderrBytes }; },
    get error() { return reason; },
    async next() {
      while (frames.length === 0) {
        if (stopped) throw reason;
        await new Promise((resolve) => { wake = resolve; });
      }
      const item = frames.shift(); queuedBytes -= item.bytes;
      return item.frame;
    },
    send(value) {
      if (stopped || !child.stdin.writable) throw reason ?? new Error("private channel closed");
      if (!child.stdin.write(JSON.stringify(value) + "\n")) throw new Error("private stdin backpressure");
    },
    abort() { fail("private run aborted"); child.kill(); },
    async reap(deadlineAt) {
      closing = true;
      child.stdin.end();
      const delay = Math.max(1, Math.min(2500, deadlineAt - Date.now()));
      let timer;
      let result = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve(null), delay); })]);
      clearTimeout(timer);
      if (!result) {
        child.kill("SIGKILL");
        result = await Promise.race([exited, new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(1, Math.min(1000, deadlineAt - Date.now()))); })]);
        clearTimeout(timer);
      }
      return result;
    },
  };
}
