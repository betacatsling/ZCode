interface RootStartupGateState {
  isResolvingProviderStartupState: boolean;
  isRestoring: boolean;
  isBootstrappingInitialWorkspace: boolean;
}

interface StartupProductLoginInput {
  hasUser: boolean;
  providerFamilyDomain: string | null | undefined;
  hasUsableProvider: boolean;
  modelSelectionFailed: boolean;
}

interface RootStartupLoadingVisibilityState extends RootStartupGateState {
  isDesktop: boolean | undefined;
  welcomeScreenOpen: boolean;
}

interface FallbackWorkspaceCreateState {
  isMounted: boolean;
  activeWorkspacePath: string | null;
}

interface ProviderStartupSyncState {
  modelSelectionViewHydrated: boolean;
}

interface ProviderStartupResolutionState {
  providerStartupSyncPending: boolean;
  providerAvailabilityStartupCheckCompleted: boolean;
}

export function shouldBlockRootRender(state: RootStartupGateState): boolean {
  // 产品 user / OAuth 恢复不再挡住工作区、历史和设置。
  // 仍等待模型视图读取结束（失败由调用方标成已结束）以及既有 tab/workspace 引导。
  return (
    state.isResolvingProviderStartupState ||
    state.isRestoring ||
    state.isBootstrappingInitialWorkspace
  );
}

export function shouldRedirectStartupToProductLogin(input: StartupProductLoginInput): boolean {
  // 没有产品账号、provider family 或可执行模型时，都不能打开产品登录。
  // 模型目录读取失败保留数据错误提示，发送/创建入口自行解释缺项。
  if (input.modelSelectionFailed) return false;
  if (!input.providerFamilyDomain) return false;
  if (!input.hasUser || !input.hasUsableProvider) return false;
  return false;
}

export function shouldShowRootStartupLoading(state: RootStartupLoadingVisibilityState): boolean {
  // 登录入口是启动门禁的结果，不是可继续被门禁遮挡的后台状态。
  // 如果 WelcomeScreen 已经打开，继续返回启动 loading 会把未登录用户卡在黑屏 logo。
  return Boolean(state.isDesktop) && !state.welcomeScreenOpen && shouldBlockRootRender(state);
}

export function shouldEnableProviderAvailabilityLoginEntryGuard(): boolean {
  return true;
}

export function shouldResolveProviderStartupState(state: ProviderStartupResolutionState): boolean {
  return state.providerStartupSyncPending || !state.providerAvailabilityStartupCheckCompleted;
}

export function shouldOpenFallbackWorkspaceAfterCreate(
  state: FallbackWorkspaceCreateState,
): boolean {
  return state.isMounted && !state.activeWorkspacePath;
}

export function isProviderStartupSyncPending(state: ProviderStartupSyncState): boolean {
  return !state.modelSelectionViewHydrated;
}
