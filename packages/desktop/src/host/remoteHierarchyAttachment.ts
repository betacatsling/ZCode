import { IWorkspaceHierarchyService, type ServiceCollection } from "@zcode/services";
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
    action: (services: ServiceCollection) => Promise<T>,
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
          const result = await run(async (services) =>
            services.get(IWorkspaceHierarchyService).createAgent(request),
          );
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
