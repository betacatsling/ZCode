/**
 * useOAuth —— OAuth 登录流程 hook
 *
 * 仅负责发起登录和 UI 状态管理。
 * OAuth 回调监听在 Root/App 常驻层，不在此 hook 中。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { OAuthProviderId, OAuthProviderMeta } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { LoginEntryPurpose } from "@/store/index.js";
import { useZCodeStore } from "@/store/StoreProvider.js";
import { logger } from "../logger.js";

type OAuthStatus = "idle" | "waiting" | "error";

export function useOAuth() {
  const { intl } = useZCodeIntl();
  const [status, setStatus] = useState<OAuthStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [providers, setProviders] = useState<OAuthProviderMeta[]>([]);
  const [activeProvider, setActiveProvider] = useState<OAuthProviderId | null>(null);
  const [loadingProviders, setLoadingProviders] = useState(true);
  const [pendingProvider, setPendingProvider] = useState<OAuthProviderId | null>(null);
  const loginAttemptRef = useRef(0);
  const setOAuthPollingActive = useZCodeStore((state) => state.setOAuthPollingActive);

  const refreshProviders = useCallback(async () => {
    // 产品 OAuth provider 列表已拆除。登录页保持空列表，不发请求。
    setProviders([]);
    setActiveProvider(null);
    setLoadingProviders(false);
  }, []);

  useEffect(() => {
    void refreshProviders();
  }, [refreshProviders]);

  const startLogin = useCallback(
    async (provider: OAuthProviderId, options: { purpose?: LoginEntryPurpose } = {}) => {
      const loginAttempt = ++loginAttemptRef.current;
      try {
        setStatus("waiting");
        setError(null);
        setPendingProvider(provider);

        // 产品 OAuth 已拆除。登录入口保留错误态，不再打开浏览器或轮询。
        void options;
        throw new Error("product_oauth_removed");
      } catch (err) {
        // 旧 init 的失败可能晚于新登录成功返回，不能反向关闭新 flow 的轮询或覆盖 UI。
        if (loginAttemptRef.current !== loginAttempt) {
          return;
        }
        logger.error("[useOAuth] 启动 OAuth 失败:", err);
        setOAuthPollingActive(false);
        setStatus("error");
        // OAuth 启动失败也属于登录失败，不把服务端或平台错误原文展示给用户。
        // 原文通过 i18n 渲染，避免登录页出现 provider/token 等具体失败原因。
        setError(intl.formatMessage({ id: "login.oauth.loginFailure" }));
        setPendingProvider(null);
      }
    },
    [intl, setOAuthPollingActive],
  );

  const cancel = useCallback(
    async (_provider?: OAuthProviderId) => {
      loginAttemptRef.current += 1;
      setOAuthPollingActive(false);
      setStatus("idle");
      setError(null);
      setPendingProvider(null);
    },
    [setOAuthPollingActive],
  );

  const reset = useCallback(() => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
  }, []);

  /** 由 Root/App 层的回调监听器调用，更新 UI 状态 */
  const setOAuthError = useCallback((message: string) => {
    setStatus("error");
    setError(message);
    setPendingProvider(null);
  }, []);

  const setOAuthSuccess = useCallback(async () => {
    setStatus("idle");
    setError(null);
    setPendingProvider(null);
    await refreshProviders();
  }, [refreshProviders]);

  return {
    startLogin,
    cancel,
    reset,
    status,
    error,
    providers,
    activeProvider,
    loadingProviders,
    pendingProvider,
    refreshProviders,
    setOAuthError,
    setOAuthSuccess,
  };
}
