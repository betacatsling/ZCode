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
  // 产品登录页已卸：启动路径恒不重定向。保留入参校验形状，避免调用方误以为缺项会打开登录。
  // 模型目录读取失败保留数据错误提示，发送/创建入口自行解释缺项。
  if (input.modelSelectionFailed) return false;
  if (!input.providerFamilyDomain) return false;
  if (!input.hasUser || !input.hasUsableProvider) return false;
  return false;
}

export function shouldShowRootStartupLoading(state: RootStartupLoadingVisibilityState): boolean {
  // 产品 Welcome 登录壳已卸；welcomeScreenOpen 仅作兼容门闩（调用方固定 false）。
  // 桌面端启动仍按既有 restore/bootstrap 门禁展示 loading，不再与登录页互斥。
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
