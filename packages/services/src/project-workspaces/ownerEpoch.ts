import { randomUUID } from "node:crypto";

let processOwnerEpoch: string | undefined;

/**
 * 进程级 occupancy owner epoch：同一 Core/宿主进程内所有 occupancy marker
 * （profile lock、catalog lock、target lease）写入同一个随机值。可信 Supervisor
 * 在托管 Core 存活期通过私有 IPC 记录该 epoch；进程崩溃后，仅当某把锁的
 * {pid, ownerEpoch} 精确命中“父进程已观察到 exit/close 并完成收割”的 managed
 * generation 记录时才允许退休。非受管进程、旧格式（无 epoch）、PID 复用或任何
 * 不一致一律 fail closed。该值只在创建 marker 时惰性生成，进程退出即不可复现。
 */
export function getProcessOwnerEpoch(): string {
  return (processOwnerEpoch ??= randomUUID());
}
