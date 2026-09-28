/**
 * useTokenRefresh —— Token 刷新 hook（常驻层）
 *
 * 产品 OAuth 已拆除。Root 仍挂载这个 hook，但刷新和清凭据都是空操作。
 */
import { useCallback } from "react";

export function useTokenRefresh() {
  // 产品 OAuth 刷新已拆除。401 不再触发全局 refresh/logout。
  const tryRefresh = useCallback(async (): Promise<boolean> => false, []);
  const clearCredentials = useCallback(async () => {}, []);
  return { tryRefresh, clearCredentials };
}
