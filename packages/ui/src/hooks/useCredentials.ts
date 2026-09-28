/**
 * useCredentials —— 凭据服务 hooks
 */
import { useCallback } from "react";
import { useServices } from "./useServices.js";

/** 凭据管理的基础 hook */
export function useCredentials() {
  const { credentialService } = useServices();

  const load = useCallback((key: string) => credentialService.load(key), [credentialService]);
  const save = useCallback(
    (key: string, value: string) => credentialService.save(key, value),
    [credentialService],
  );
  const del = useCallback((key: string) => credentialService.delete(key), [credentialService]);

  return { load, save, delete: del };
}

/** active provider access_token 专用便捷 hook */
export function useAuthToken() {
  // 产品登录已拆除，没有 active provider token 可读。
  const getToken = useCallback(async () => null, []);
  const setToken = useCallback(async (_token: string) => {
    throw new Error("产品登录已移除，无法写入 auth token");
  }, []);
  const clearToken = useCallback(async () => {}, []);
  return { getToken, setToken, clearToken };
}
