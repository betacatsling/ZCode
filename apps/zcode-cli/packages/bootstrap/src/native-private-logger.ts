import type { Logger, LoggerFactory } from "@zcode/contracts";

// 私有 opt-in runner 专用：生产日志器会把 SDK 返回的 endpoint/错误文本落盘；
// 该短命验证只记录白名单计数，不写产品日志，拒绝把敏感 cause 透传到文件。
export function createPrivateNoopLoggerFactory(): LoggerFactory {
  const logger: Logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    child() {
      return logger;
    },
  };
  return { createLogger: () => logger, withContext: () => logger, setLevel() {} };
}
