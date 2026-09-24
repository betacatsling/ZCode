import type { RuntimeActivity } from "../contracts.js";

/** Native 与 Host owner 的 unsafe 汇总；approval 等待和崩溃后的未知都不可打断。 */
export function unsafeActivityCount(nativeRunning: number, external: RuntimeActivity): number {
  return nativeRunning + external.running + external.waiting + external.uncertain;
}
