import { readLegacyZCodeSession } from "../sessionRouter.js";

/** 旧程序只重放被现有分类认成 native 的记录。外部 sidecar 不在此列。 */
export function nativeReplayIds(records: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const record of records) {
    const read = readLegacyZCodeSession(record);
    if (read.kind === "native") ids.push(read.hostSessionId);
  }
  return ids;
}
