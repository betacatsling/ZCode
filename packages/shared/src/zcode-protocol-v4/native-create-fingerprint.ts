import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, part]) => part !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, part]) => [key, canonical(part)]),
    );
  return value;
}
/** The same validated V4 create payload enters CLI receipt and Core immutable intent. */
export function nativeCreatePayloadFingerprint(raw: unknown): string {
  // 中文：CLI 历史收据对已验证的实际 payload 算摘要；升级 schema 不能
  // 丢弃原有字段后改变同一 commandId 的指纹语义。
  return createHash("sha256")
    .update(JSON.stringify(canonical(raw)))
    .digest("hex");
}
