import { join } from "node:path";
import { Emitter } from "@zcode/rpc";
import type { ProviderRegistryService } from "@zcode/provider";
import {
  writableSessionSpecV2Schema,
  harnessManifestSchema,
  type ExecutionTarget,
  type HarnessManifest,
} from "@zcode/shared/agent-host";
import { HarnessRegistry, type HarnessAdapter } from "./harnessRegistry.js";
import { createRegistryModelCatalog } from "./registryCatalog.js";
import { createRpcAgentHostService } from "./rpcTargetService.js";
import type { IAgentHostService } from "./serviceContract.js";
import {
  AgentHostTargetService,
  type TargetHostEvent,
  type WorkspaceAdmissionPort,
} from "./targetService.js";

const piManifest: HarnessManifest = {
  schemaVersion: 1,
  id: "pi",
  name: "Pi",
  adapterVersion: "0.87.1",
};

/** Lazy registration avoids loading Pi/CLI model adapters during native-only startup. */
export function createLazyTargetAgentHostService(input: {
  root: string;
  target: ExecutionTarget;
  registry: ProviderRegistryService;
  allowNewSessions: () => boolean;
  admission: WorkspaceAdmissionPort;
  additionalTrustedHarnesses?: readonly {
    manifest: HarnessManifest;
    factory: () => HarnessAdapter;
  }[];
}): { service: IAgentHostService; dispose(): Promise<void> } {
  // 中文：若后列 manifest 重复/非法，不能先运行前列 factory（可能已占有进程或端口）。
  // Node-only 构造阶段预检全表；真正注册时 HarnessRegistry 仍校验 adapter 与 manifest 一致。
  const seen = new Set([piManifest.id]);
  for (const trusted of input.additionalTrustedHarnesses ?? []) {
    const manifest = harnessManifestSchema.parse(trusted.manifest);
    if (seen.has(manifest.id)) throw new Error(`duplicate-id: ${manifest.id}`);
    seen.add(manifest.id);
  }
  let target: AgentHostTargetService | undefined;
  let flight: Promise<AgentHostTargetService> | undefined;
  let targetDispose: (() => void) | undefined;
  let disposed = false;
  const events = new Emitter<TargetHostEvent>();
  const historyOnly = new AgentHostTargetService({
    root: join(input.root, "sessions"),
    target: input.target,
    catalog: {
      fingerprint: "history-only",
      validateSelection: () => ({ ok: false as const, reason: "history-only" }),
    },
    registry: new HarnessRegistry(),
    admission: input.admission,
  });
  const getTarget = async (): Promise<AgentHostTargetService> => {
    if (disposed) throw new Error("agent host service disposed");
    if (target) return target;
    if (!flight)
      flight = (async () => {
        await input.registry.start();
        if (disposed) throw new Error("agent host service disposed during registry startup");
        const { createRegistryPiHarness } = await import("../agent-adapters/pi/createPiHarness.js");
        if (disposed) throw new Error("agent host service disposed during adapter startup");
        const harnesses = new HarnessRegistry();
        harnesses.registerTrusted(piManifest, () =>
          createRegistryPiHarness({ root: join(input.root, "workers"), registry: input.registry }),
        );
        // 中文：仅调用方的 Node 工厂可注入；严格验证 manifest/重复 ID，永不从仓库元数据执行代码。
        for (const trusted of input.additionalTrustedHarnesses ?? [])
          harnesses.registerTrusted(trusted.manifest, trusted.factory);
        // 中文：异步 import/Registry 可能晚于 close；关停后不得产生新的 Host 或写入者。
        if (disposed) throw new Error("agent host service disposed during adapter startup");
        const instance = new AgentHostTargetService({
          root: join(input.root, "sessions"),
          target: input.target,
          catalog: createRegistryModelCatalog(input.registry),
          registry: harnesses,
          admission: input.admission,
        });
        const rpc = createRpcAgentHostService(instance, input.allowNewSessions);
        const unsubscribe = rpc.service.onEvent((event) => events.fire(event));
        targetDispose = () => {
          unsubscribe.dispose();
          rpc.dispose();
        };
        target = instance;
        return instance;
      })().catch((error: unknown) => {
        flight = undefined;
        throw error;
      });
    return flight;
  };
  const service: IAgentHostService = {
    onEvent: events.event,
    getAvailability: async () => ({
      target: input.target,
      // 中文：读取只公布构造阶段已验证的受信清单；不启动 Registry/adapter，也不新增生产 Pi 以外的模型资格。
      harnesses: [...seen],
      admissionEnabled: input.allowNewSessions() && input.target.available,
    }),
    catalogForTarget: async (targetId) => (await getTarget()).catalogForTarget(targetId),
    getSessionCapabilities: (spec) => (target ?? historyOnly).getSessionCapabilities(spec),
    getRuntimeActivity: (workspaceId) => (target ?? historyOnly).getRuntimeActivity(workspaceId),
    getSessionReadModel: (spec) => (target ?? historyOnly).getSessionReadModel(spec),
    getSessionSpec: (scope) => (target ?? historyOnly).getSessionSpec(scope),
    listWorkspaceSessions: (workspaceId) =>
      (target ?? historyOnly).listWorkspaceSessions(workspaceId),
    rowsRange: (spec, request) => (target ?? historyOnly).rowsRange(spec, request),
    async listSessions(workspaceIdentity, worktreePath) {
      return (target ?? historyOnly).listSessions(workspaceIdentity, worktreePath);
    },
    async create(spec, commandId) {
      if (!input.allowNewSessions()) {
        const prior = await (target ?? historyOnly).queryCreationCommand(commandId);
        if (
          prior &&
          JSON.stringify(prior.spec) === JSON.stringify(writableSessionSpecV2Schema.parse(spec)) &&
          prior.receipt.status === "completed"
        )
          return (target ?? historyOnly).snapshot(prior.spec);
        throw new Error("new external sessions disabled; existing history remains readable");
      }
      return (await getTarget()).create(spec, commandId);
    },
    queryCreationCommand: (commandId) => (target ?? historyOnly).queryCreationCommand(commandId),
    async attach(spec) {
      return (await getTarget()).attach(spec);
    },
    async dispatch(spec, command) {
      // 控制已接受的轮次不应仅因调用而懒启动 Pi；冷 Host 不持有 epoch，必须显式 attach。
      if (
        command.type === "cancelTurn" ||
        command.type === "detach" ||
        command.type === "viewHistory" ||
        command.type === "terminateSession" ||
        (command.type === "resolveInteraction" && command.decision === "deny")
      )
        return (target ?? historyOnly).dispatch(spec, command);
      // 已挂载 Host 的已接受 ID 可在关停新 admission 后取得重复回执；不为冷历史启动 worker。
      if (target && (await target.queryCommand(spec, command.commandId)))
        return target.dispatch(spec, command);
      if (!input.allowNewSessions())
        throw new Error("new external execution disabled; existing history remains readable");
      return (await getTarget()).dispatch(spec, command);
    },
    async snapshot(spec) {
      return (target ?? historyOnly).snapshot(spec);
    },
    async eventsSince(spec, sequence) {
      return (target ?? historyOnly).eventsSince(spec, sequence);
    },
    async queryCommand(spec, commandId) {
      return (target ?? historyOnly).queryCommand(spec, commandId);
    },
  };
  return {
    service,
    async dispose() {
      disposed = true;
      targetDispose?.();
      events.dispose();
      // Process shutdown with an active turn leaves durable accepted/unknown; no
      // fabricated completion or implicit prompt replay on the next target epoch.
      await flight?.catch(() => undefined);
      if (target) await target.close();
      await historyOnly.close();
    },
  };
}
