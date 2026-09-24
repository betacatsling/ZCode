import {
  IAgentHostService,
  IWorkspaceHierarchyService,
  type ServiceCollection,
} from "@zcode/services";
import type { WindowHostAttachmentScope } from "@zcode/shared";

export class RemoteCreateUncertainError extends Error {
  readonly recovery = "query-by-stable-command-id" as const;
  constructor() {
    super("Remote creation outcome uncertain; inspect original command ID without resending");
  }
}

/** Only Host may supply this callback: it captures its own validated registry generation. */
export function createRemoteHierarchyAttachment(
  base: IWorkspaceHierarchyService,
  scope: Extract<WindowHostAttachmentScope, { kind: "remote" }>,
  run: <T>(
    action: (services: ServiceCollection, assertCurrent: () => void) => Promise<T>,
  ) => Promise<
    | { status: "committed"; value: T }
    | { status: "uncertain"; recovery: "query-by-stable-command-id" }
  >,
) {
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === "createAgent") {
        return async (request: Parameters<IWorkspaceHierarchyService["createAgent"]>[0]) => {
          // 中文：renderer 的 request 没有路由权；只通过 Host 捕获的当前 registry scope 找目标 Core。
          const result = await run(async (services, assertCurrent) => {
            if (!request.workspaceId?.trim() || !scope.workspaceIdentity?.trim()) {
              throw new Error("Unscoped remote creation denied");
            }
            // 中文：目标 ID 取自该连接的真实 Core Host，不从 renderer 请求或路径推断。
            // hierarchy.resolveWorkspace 在目标 Core 的 Catalog 内查证唯一 workspace。
            const availability = await services.get(IAgentHostService).getAvailability();
            if (!availability.target.available || !availability.target.id) {
              throw new Error("Remote target unavailable");
            }
            const hierarchy = services.get(IWorkspaceHierarchyService);
            const certified = await hierarchy.resolveWorkspace({
              workspacePath: scope.workspacePath,
              workspaceIdentity: scope.workspaceIdentity,
              targetId: availability.target.id,
            });
            if (
              certified?.workspaceId !== request.workspaceId ||
              certified.targetId !== availability.target.id ||
              certified.workspacePath !== scope.workspacePath ||
              certified.workspaceIdentity !== scope.workspaceIdentity ||
              (certified.remoteSessionId !== undefined &&
                certified.remoteSessionId !== scope.remoteSessionId)
            ) {
              throw new Error("Remote target scope denied");
            }
            // 中文：Host/Target 查找均为异步；提交前必须再次确认原连接代际仍在，
            // 不能只在 await 之前鉴权。可能已提交但 ACK 丢失时由外层报告不确定，绝不重试。
            assertCurrent();
            return hierarchy.createAgent(request);
          });
          if (result.status === "uncertain") throw new RemoteCreateUncertainError();
          const owner = result.value.owner;
          if (
            owner.scope.workspaceId !== request.workspaceId ||
            owner.scope.workspacePath !== scope.workspacePath ||
            owner.scope.workspaceIdentity !== scope.workspaceIdentity ||
            (owner.scope.remoteSessionId && owner.scope.remoteSessionId !== scope.remoteSessionId)
          ) {
            // 中文：提交后目标身份不匹配只能只读检查原命令，绝不可向另一 target 自动重发。
            throw new RemoteCreateUncertainError();
          }
          return {
            ...result.value,
            owner: {
              ...owner,
              scope: { ...owner.scope, remoteSessionId: scope.remoteSessionId },
            },
          };
        };
      }
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
