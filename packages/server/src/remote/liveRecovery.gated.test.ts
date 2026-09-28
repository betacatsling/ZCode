import { execFileSync } from "node:child_process";
import test, { type TestContext } from "node:test";

/**
 * Mac 实机恢复只登记跳过条件。
 * 不是 darwin、没有 Mac 桌面、或缺少 Electron / Provider 凭据时必须跳过。
 * 即便环境齐了，本进程也不关窗口、不退出 Electron、不读取审批，因此不能记为通过。
 * 手工步骤和通过/失败标准在 docs/harness-refactor/MAC-TEST.md。
 * 这里不连接 Linux 远端，也不覆盖 Windows / WSL。
 */

const ELECTRON_EXECUTABLE_ENV = "ZCODE_LIVE_ELECTRON_EXECUTABLE";
const PROVIDER_API_KEY_ENV = "ZCODE_LIVE_PROVIDER_API_KEY";

const WINDOW_CLOSE_STEPS =
  "用现有 server-cli serve --daemon 由本机 launchd 拉起；只关窗口，不发 explicit-stop；Core 的 state 仍为 ready，pid 不变，serviceRegistered 仍为 true";
const ELECTRON_QUIT_STEPS =
  "已接受任务记下 commandId；退出整个 Electron；任务继续且不被标成完成；重连不再次接受同一条 prompt";
const APPROVAL_STEPS =
  "审批等待时记下 interactionId；关掉再打开；仍是同一个待决请求，重连不代替允许或拒绝";

function missingCredentialNames(): string[] {
  const missing: string[] = [];
  if (!process.env[ELECTRON_EXECUTABLE_ENV]?.trim()) missing.push(ELECTRON_EXECUTABLE_ENV);
  if (!process.env[PROVIDER_API_KEY_ENV]?.trim()) missing.push(PROVIDER_API_KEY_ENV);
  return missing;
}

function macDesktopAvailable(): boolean {
  if (process.platform !== "darwin") return false;
  try {
    const uid = execFileSync("/usr/bin/id", ["-u"], { encoding: "utf8", timeout: 2_000 }).trim();
    if (!/^[0-9]+$/u.test(uid)) return false;
    execFileSync("/bin/launchctl", ["print", `gui/${uid}`], {
      stdio: "ignore",
      timeout: 2_000,
    });
    return true;
  } catch {
    return false;
  }
}

function skipReason(title: string, steps: string): string {
  if (process.platform !== "darwin") {
    return [
      `跳过「${title}」：当前平台是 ${process.platform}，不是 darwin。`,
      "只在 Mac 上测本机 serve --daemon（launchd）和关掉 Mac 上的 Electron。",
      "不测 Linux SSH、Windows、WSL，也不连接远端。",
      `未执行：${steps}。`,
      "未运行，不能记为通过。",
    ].join("");
  }
  if (!macDesktopAvailable()) {
    return `跳过「${title}」：没有 Mac 桌面会话。未执行：${steps}。未运行，不能记为通过。`;
  }
  const missing = missingCredentialNames();
  if (missing.length > 0) {
    return `跳过「${title}」：缺少 ${missing.join("、")}。没有真实 Electron 或 Provider 凭据。未执行：${steps}。未读取密钥，不能记为通过。`;
  }
  return `跳过「${title}」：环境已齐，但本进程不观察窗口、Electron 或审批。请按 docs/harness-refactor/MAC-TEST.md 手工记录。未执行：${steps}。未观察，不能记为通过。`;
}

function registerSkippedScenario(title: string, steps: string): void {
  const reason = skipReason(title, steps);
  test(title, { skip: reason }, (t: TestContext) => {
    t.diagnostic(reason);
    throw new Error(`${reason} 跳过的实机用例不应继续执行。`);
  });
}

registerSkippedScenario("窗口关闭后 Core 仍在", WINDOW_CLOSE_STEPS);
registerSkippedScenario("Electron 全退后任务继续且不重发 prompt", ELECTRON_QUIT_STEPS);
registerSkippedScenario("审批中断线仍是同一请求", APPROVAL_STEPS);
