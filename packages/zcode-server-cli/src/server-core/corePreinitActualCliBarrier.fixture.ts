import { createReadStream } from "node:fs";
import { once } from "node:events";

// 测试夹具：CLI 主模块执行前等待父 wrapper 确认早到的 V4 帧已经写入 stdin。
if (process.env.ZCODE_CORE_BOOT_ADMISSION === "held") {
  const gate = createReadStream(process.platform === "win32" ? "NUL" : "/dev/null", {
    fd: 3,
    autoClose: false,
  });
  await once(gate, "data");
  gate.destroy();
}
