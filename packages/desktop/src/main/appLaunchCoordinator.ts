interface AppLaunchGateLike {
  consume(): boolean;
}

interface RendererReadyInput {
  hasPendingOAuthCallback: boolean;
  rendererId: number;
}

export function createAppLaunchCoordinator(appLaunchGate: AppLaunchGateLike) {
  return {
    onRendererReady(_input: RendererReadyInput): boolean {
      // 产品 OAuth pending 路径已卸：renderer ready 即消费启动闸门。
      return appLaunchGate.consume();
    },

    onOAuthCallbackHandled(_input: { rendererId: number }): boolean {
      // 产品 OAuth deep-link 已卸；保留签名以免拖动 telemetry runtime 大改。
      return false;
    },
  };
}
