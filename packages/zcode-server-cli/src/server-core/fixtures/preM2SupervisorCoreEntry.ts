import { z } from "zod";

// 模拟 pre-M2 Supervisor 看到的新 Core：旧 coreMessageSchema.ready 没有 hostBootstrapToken 字段，
// zod 默认 strip 会把它丢掉。这里在 Core 侧用同形状的旧 schema 过滤 ready，再运行真实的 mock Core，
// 让真实（新）Supervisor 只收到旧 Supervisor 会保留的字段。
const preM2ReadySchema = z.object({
  type: z.literal("ready"),
  host: z.string().min(1),
  port: z.number().int().positive(),
  version: z.string().min(1),
  generation: z.number().int().nonnegative(),
});

const send = process.send?.bind(process);
if (!send) throw new Error("pre-M2 Supervisor fixture requires an IPC channel");
process.send = ((message: unknown, ...rest: unknown[]) => {
  const ready = preM2ReadySchema.safeParse(message);
  return (send as (...args: unknown[]) => boolean)(ready.success ? ready.data : message, ...rest);
}) as typeof process.send;

await import("./mockCoreEntry.js");
