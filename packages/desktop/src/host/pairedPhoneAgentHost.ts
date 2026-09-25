import {
  IAgentHostService,
  IWorkspaceHierarchyService,
  type ServiceCollection,
} from "@zcode/services";
import { ProxyChannel, type IChannelServer } from "@zcode/rpc";
import { writableSessionSpecV2Schema, type SessionSpecV2 } from "@zcode/shared/agent-host";

export function registerPairedPhoneChannel(
  server: IChannelServer,
  services: ServiceCollection,
  scope: {
    workspaceId: string;
    hostSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
  },
  current: () => boolean,
): void {
  // 中文：普通 attachment 暴露所有 ServiceCollection；手机只有经 Core 核验的精确方法。
  const allowed = new Set([
    "getSessionSpec",
    "listWorkspaceSessions",
    "attach",
    "snapshot",
    "eventsSince",
    "rowsRange",
    "queryCommand",
    "dispatch",
  ]);
  const channel = ProxyChannel.fromService(
    createPairedPhoneAgentHost(
      services.get(IAgentHostService),
      services.get(IWorkspaceHierarchyService),
      scope,
      current,
    ),
  );
  server.registerChannel(IAgentHostService.channelName, {
    call(ctx, command, args, token) {
      if (!allowed.has(command)) throw new Error("phone method denied");
      return channel.call(ctx, command, args, token);
    },
    listen(ctx, event, arg) {
      if (event !== "onEvent") throw new Error("phone event denied");
      return channel.listen(ctx, event, arg);
    },
  });
}

/** Narrow RPC surface for an already paired view. Never hand the window-wide collection to a phone. */
export function createPairedPhoneAgentHost(
  host: IAgentHostService,
  hierarchy: IWorkspaceHierarchyService,
  scope: {
    workspaceId: string;
    hostSessionId: string;
    workspacePath: string;
    workspaceIdentity: string;
  },
  current: () => boolean,
) {
  const denied = () => new Error("phone attachment denied");
  let certifiedSession: string | undefined;
  function checkCurrent(): void {
    if (!current()) throw denied();
  }
  async function workspace(): Promise<string> {
    checkCurrent();
    // 中文：workspaceId 不可从手机请求推断；Host 现读目标与 Catalog，并在异步查询后再次检查租约。
    const availability = await host.getAvailability();
    if (!availability.target.available || !availability.target.id) throw denied();
    const targetId = availability.target.id;
    const record = await hierarchy.resolveWorkspace({
      workspacePath: scope.workspacePath,
      workspaceIdentity: scope.workspaceIdentity,
      targetId,
    });
    checkCurrent();
    if (
      !record ||
      record.workspaceId !== scope.workspaceId ||
      record.targetId !== targetId ||
      record.workspaceIdentity !== scope.workspaceIdentity ||
      record.workspacePath !== scope.workspacePath
    )
      throw denied();
    return targetId;
  }
  async function session(spec: SessionSpecV2): Promise<void> {
    const targetId = await workspace();
    if (
      spec?.schemaVersion !== 2 ||
      spec.workspaceId !== scope.workspaceId ||
      spec.execution?.targetId !== targetId ||
      spec.execution.workspaceIdentity !== scope.workspaceIdentity ||
      spec.execution.worktreePath !== scope.workspacePath ||
      spec.hostSessionId !== scope.hostSessionId
    )
      throw denied();
    // 中文：手机可伪造整个 spec。以 Core 当前持久 owner 为准，不能只比较 workspaceId。
    const stored = await host.getSessionSpec({
      targetId,
      workspaceId: scope.workspaceId,
      hostSessionId: spec.hostSessionId,
    });
    checkCurrent();
    const requested = writableSessionSpecV2Schema.safeParse(spec);
    const owned = writableSessionSpecV2Schema.safeParse(stored);
    if (
      !requested.success ||
      !owned.success ||
      JSON.stringify(owned.data) !== JSON.stringify(requested.data)
    )
      throw denied();
    certifiedSession = JSON.stringify(owned.data);
  }
  const phone = {
    async getSessionSpec(query: Parameters<IAgentHostService["getSessionSpec"]>[0]) {
      const targetId = await workspace();
      if (
        query?.targetId !== targetId ||
        query.workspaceId !== scope.workspaceId ||
        query.hostSessionId !== scope.hostSessionId
      )
        throw denied();
      const result = await host.getSessionSpec(query);
      checkCurrent();
      if (result) {
        if (
          result.workspaceId !== scope.workspaceId ||
          result.execution.targetId !== targetId ||
          result.execution.workspaceIdentity !== scope.workspaceIdentity ||
          result.execution.worktreePath !== scope.workspacePath
        )
          throw denied();
        const owned = writableSessionSpecV2Schema.safeParse(result);
        if (!owned.success || result.hostSessionId !== scope.hostSessionId) throw denied();
        certifiedSession = JSON.stringify(owned.data);
      }
      return result;
    },
    async listWorkspaceSessions(workspaceId: string) {
      const targetId = await workspace();
      if (workspaceId !== scope.workspaceId) throw denied();
      const results = await host.listWorkspaceSessions(workspaceId);
      checkCurrent();
      // 中文：即使服务端索引被污染，也不能将其它 identity 的摘要泄露给手机。
      return results.filter(
        ({ spec }) =>
          spec.schemaVersion === 2 &&
          spec.workspaceId === scope.workspaceId &&
          spec.hostSessionId === scope.hostSessionId &&
          spec.execution.targetId === targetId &&
          spec.execution.workspaceIdentity === scope.workspaceIdentity &&
          spec.execution.worktreePath === scope.workspacePath,
      );
    },
    async attach(spec: SessionSpecV2) {
      await session(spec);
      return host.attach(spec);
    },
    async snapshot(spec: SessionSpecV2) {
      await session(spec);
      return host.snapshot(spec);
    },
    async eventsSince(spec: SessionSpecV2, sequence: number) {
      await session(spec);
      return host.eventsSince(spec, sequence);
    },
    async rowsRange(spec: SessionSpecV2, request: Parameters<IAgentHostService["rowsRange"]>[1]) {
      await session(spec);
      return host.rowsRange(spec, request);
    },
    async queryCommand(spec: SessionSpecV2, commandId: string) {
      await session(spec);
      return host.queryCommand(spec, commandId);
    },
    async dispatch(spec: SessionSpecV2, command: Parameters<IAgentHostService["dispatch"]>[1]) {
      await session(spec);
      checkCurrent();
      return host.dispatch(spec, command);
    },
    onEvent: (listener: Parameters<IAgentHostService["onEvent"]>[0]) => {
      checkCurrent();
      return host.onEvent((event) => {
        if (
          current() &&
          event.spec.schemaVersion === 2 &&
          event.spec.workspaceId === scope.workspaceId &&
          event.spec.hostSessionId === scope.hostSessionId &&
          event.spec.execution.workspaceIdentity === scope.workspaceIdentity &&
          event.spec.execution.worktreePath === scope.workspacePath &&
          certifiedSession !== undefined &&
          certifiedSession ===
            JSON.stringify(writableSessionSpecV2Schema.safeParse(event.spec).data)
        )
          listener(event);
      });
    },
  };
  return phone;
}
