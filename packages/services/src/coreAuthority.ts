import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getAppConfigDir, getTasksIndexDatabasePath } from "./paths.js";
import { ProfileFileOwner } from "./project-workspaces/profilePersistence.js";
import { legacyBackupSchema, mappingSchema } from "./project-workspaces/migrationContract.js";
import { NativePersistentSessionIndex } from "./session/nativePersistentSessionIndex.js";
import { prepareTasksIndexStorage } from "./session/tasksDatabase/startup.js";
import { NativeSqliteMetadataReader } from "./session/nativeSessionMetadata.js";
import { ReadonlyNativeSessionMetadataView } from "@zcode/adapters/storage";
import { resolveNativeSessionDbPath } from "@zcode/adapters/config";
import {
  createReadonlyNativeDirectory,
  createNativeProductionBridge,
} from "./workspace-hierarchy/nativeProductionBridge.js";
import type { NativeRuntimeFactsPort } from "./workspace-hierarchy/nativeProductionBridge.js";
import {
  getNativeProcessControlPort,
  getNativeCreationControlPort,
  NativeCreationOwnershipChangedError,
} from "./zcode-agent/zcodeAgentService.js";
import { readNativeCatalogReferences } from "./project-workspaces/projectCatalog.js";
import { NativeCreateJournal } from "./workspace-hierarchy/nativeCreateJournal.js";
import { nativeCreatePayloadFingerprint } from "@zcode/shared/zcode-protocol-v4/native-create-fingerprint-node";
import { commandPayloadSchemas } from "@zcode/shared/zcode-protocol-v4";
import { IZCodeAgentService } from "./zcode-agent/zcodeAgent.js";
import type { ServiceCollection } from "./collection.js";
import type { CompositionOptions } from "./workspace-hierarchy/lazyComposition.js";
import {
  createLocalServices,
  disposeServiceResourcesAndWait,
  getWorkspaceCompositionReady,
  getWorkspaceMaintenanceCoordination,
} from "./node.js";

export interface CoreAuthorityOptions {
  installationId: string;
  /** Installation/runtime layout, not the writable profile root. */
  profileRoot: string;
  zcodeBuiltinProviderConfigFilePath: string;
  /** Default open; held is installed before composition initialization/reconciliation. */
  admissionFence?: "open" | "held";
  /** Node-only trusted harness factories; never a serialized renderer capability. */
  additionalTrustedHarnesses?: CompositionOptions["additionalTrustedHarnesses"];
}
export interface CoreAuthorityResult {
  services: ServiceCollection;
  maintenance: {
    freezeAdmissions(): Promise<{ release(): Promise<void> }>;
    readActivity(): Promise<{
      native: { running: number; waiting: number; uncertain: number };
      external: { running: number; waiting: number; uncertain: number };
    }>;
  };
  reconcileBeforeAdmission(): Promise<void>;
  bootAdmissionLease?: { release(): Promise<void> };
  dispose(): Promise<void>;
}

/** Single process owner for the actual configured DB/profile, not the server installation directory. */
export async function createCoreAuthority(
  options: CoreAuthorityOptions,
): Promise<CoreAuthorityResult> {
  if (
    !options.installationId.trim() ||
    !options.profileRoot.trim() ||
    !options.zcodeBuiltinProviderConfigFilePath.trim()
  )
    throw new Error("Core authority identity, installation and provider config required");
  const configRoot = getAppConfigDir();
  const owner = await ProfileFileOwner.open(join(configRoot, "core-authority.json"));
  let services: ServiceCollection | undefined;
  try {
    // 中文：与 CLI 共享配置解释器；读取目录不能启动 CLI 或偷偷迁移不存在的 SQLite。
    let nativeDb = resolveNativeSessionDbPath({ cwd: process.cwd(), env: process.env });
    const taskDb = getTasksIndexDatabasePath();
    // 中文：旧工厂把首次 sidebar 的缺库误当只读故障；在 Core 持有 profile writer
    // 的启动写阶段运行同一 tasks migration owner，读路径本身绝不迁移。
    await prepareTasksIndexStorage(taskDb, () => {});
    const backups = join(configRoot, "native-migration", "backups");
    const metadata = {
      read: (scope: Parameters<NativeSqliteMetadataReader["read"]>[0]) =>
        new NativeSqliteMetadataReader(
          new ReadonlyNativeSessionMetadataView(nativeDb),
          async () => options.installationId,
        ).read(scope),
    };
    const reader = new NativePersistentSessionIndex(
      taskDb,
      backups,
      options.installationId,
      metadata,
    );
    const journal = new NativeCreateJournal(join(configRoot, "native-create"));
    const sidecar = join(configRoot, "native-migration", "mapping.json");
    const listMappings = async () => {
      let text: string;
      try {
        text = await readFile(sidecar, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const parsed = z
        .strictObject({
          schemaVersion: z.literal(1),
          source: legacyBackupSchema,
          mappings: z.array(mappingSchema),
        })
        .parse(JSON.parse(text));
      if (!(await reader.verifyBackup(parsed.source))) throw new Error("unverified-native-backup");
      return parsed.mappings;
    };
    const directory = createReadonlyNativeDirectory({
      taskIndexDatabasePath: taskDb,
      nativeSessionDatabasePath: () => nativeDb,
      backupDirectory: backups,
      profileId: options.installationId,
      listMappings,
      listNewMappings: async () => {
        const references = await readNativeCatalogReferences(
          join(configRoot, "workspace-hierarchy", "profile", "catalog.json"),
        );
        return (await journal.listCompleted())
          .filter(({ intent, originalSessionId }) =>
            references.some(
              (ref) =>
                ref.commandId === intent.commandId &&
                ref.originalSessionId === originalSessionId &&
                ref.targetId === intent.targetId &&
                ref.projectId === intent.projectId &&
                ref.workspaceId === intent.workspaceId &&
                ref.repositoryBindingId === intent.repositoryBindingId &&
                ref.worktreeGeneration === intent.worktreeGeneration &&
                ref.workspaceIdentity === intent.workspaceIdentity &&
                ref.workspacePath === intent.workspacePath &&
                ref.remoteSessionId === intent.remoteSessionId,
            ),
          )
          .map(({ intent, originalSessionId }) => ({
            commandId: intent.commandId,
            nativeDatabasePath: intent.nativeDatabasePath,
            databaseId: intent.databaseId,
            nativeSessionId: originalSessionId,
            sourceWorkspaceKey: intent.workspaceIdentity,
            sourceWorkspacePath: intent.workspacePath,
            ...(intent.remoteSessionId ? { remoteSessionId: intent.remoteSessionId } : {}),
            targetId: intent.targetId,
            projectId: intent.projectId,
            workspaceId: intent.workspaceId,
            repositoryBindingId: intent.repositoryBindingId,
            worktreeGeneration: intent.worktreeGeneration,
            cwdRelativeToWorktree: intent.cwdRelativeToWorktree,
            modelBinding: intent.modelBinding,
          }));
      },
    });
    // The live native process port binds to the real service after collection construction.
    let live: ReturnType<typeof getNativeProcessControlPort> | undefined;
    let creation: ReturnType<typeof getNativeCreationControlPort> | undefined;
    const nativeEnabled = process.env.ZCODE_CORE_NATIVE_CREATE_TEST_ONLY === "1";
    type CreateRequest = Parameters<NativeRuntimeFactsPort["create"]>[0];
    const recover = async (input: CreateRequest) => {
      const state = await journal.read(input.commandId);
      if (!state) return undefined;
      const { intent } = state;
      // 中文：先核对 Catalog 与 Target 当前绑定和原命令，不按路径近似匹配；
      // 完成重试只读 SQLite，pending 不允许向 CommandInbox 再提交一次。
      if (
        intent.targetId !== input.scope.targetId ||
        intent.projectId !== input.projectId ||
        intent.workspaceId !== input.scope.workspaceId ||
        intent.repositoryBindingId !== input.repositoryBindingId ||
        intent.worktreeGeneration !== input.worktreeGeneration ||
        intent.workspaceIdentity !== input.scope.workspaceIdentity ||
        intent.workspacePath !== input.scope.workspacePath ||
        intent.remoteSessionId !== input.scope.remoteSessionId ||
        intent.cwdRelativeToWorktree !== input.cwdRelativeToWorktree ||
        JSON.stringify(intent.modelBinding) !== JSON.stringify(input.modelBinding)
      )
        throw new Error("native-create-intent-conflict");
      const mapping = state.mapping ?? (await journal.complete(input.commandId));
      return { originalSessionId: mapping.originalSessionId };
    };
    const runtime: NativeRuntimeFactsPort = {
      certifiedCreate: nativeEnabled,
      recover,
      async create(input) {
        if (!nativeEnabled || !creation)
          throw new Error("Native durable creation receipt unavailable");
        if (input.modelBinding.kind !== "host-managed" || input.cwdRelativeToWorktree !== ".")
          throw new Error("native-create-unverifiable-binding-or-cwd");
        const existing = await recover(input);
        if (existing) return existing;
        const target = {
          workspacePath: input.scope.workspacePath,
          workspaceIdentity: input.scope.workspaceIdentity,
          ...(input.scope.remoteSessionId ? { remoteSessionId: input.scope.remoteSessionId } : {}),
        };
        const description = await creation.describe(target);
        const payload = commandPayloadSchemas.createSession.parse({
          workspaceId: input.scope.workspaceIdentity,
          config: { modelSelection: input.modelBinding.selection, mode: "build" },
        });
        await journal.stage({
          schemaVersion: 1,
          commandId: input.commandId,
          targetId: input.scope.targetId,
          projectId: input.projectId,
          workspaceId: input.scope.workspaceId,
          repositoryBindingId: input.repositoryBindingId,
          worktreeGeneration: input.worktreeGeneration,
          workspaceIdentity: input.scope.workspaceIdentity,
          workspacePath: input.scope.workspacePath,
          ...(input.scope.remoteSessionId ? { remoteSessionId: input.scope.remoteSessionId } : {}),
          cwdRelativeToWorktree: input.cwdRelativeToWorktree,
          modelBinding: input.modelBinding,
          nativeDatabasePath: description.nativeDatabasePath,
          databaseId: description.databaseId,
          intentFingerprint: nativeCreatePayloadFingerprint(payload),
        });
        // 中文：写入意图后 ACK 可能丢失；只读取已完成的 CLI 收据，绝不重发 pending 命令。
        try {
          await creation.create(target, description, { commandId: input.commandId, payload });
        } catch (error) {
          // 中文：worker/DB 换代时即便旧库已有完成收据，也不能在本次调用签发
          // 当前可写 owner；只允许随后经 Target/Catalog 重验的只读恢复。
          if (error instanceof NativeCreationOwnershipChangedError) throw error;
          try {
            return {
              originalSessionId: (await journal.complete(input.commandId)).originalSessionId,
            };
          } catch {
            throw error;
          }
        }
        return { originalSessionId: (await journal.complete(input.commandId)).originalSessionId };
      },
      async capabilities(owner) {
        if (!nativeEnabled || !creation) throw new Error("Native capability unavailable");
        await creation.describe({
          workspacePath: owner.scope.workspacePath,
          workspaceIdentity: owner.scope.workspaceIdentity,
          ...(owner.scope.remoteSessionId ? { remoteSessionId: owner.scope.remoteSessionId } : {}),
        });
        const supported = { support: "supported" as const };
        const unknown = {
          support: "unknown" as const,
          reason: "not certified by native create owner",
        };
        return {
          text: supported,
          tools: unknown,
          approvals: unknown,
          cancelTurn: unknown,
          resumeExecution: unknown,
          history: supported,
          images: unknown,
          modelSwitch: unknown,
          detach: supported,
          terminateSession: unknown,
          viewHistory: supported,
          hostManagedModel: supported,
          fork: unknown,
          subagents: unknown,
        };
      },
      async activity() {
        if (!live) return { running: 0, waiting: 0, tools: 0, uncertain: 1, offline: true };
        const facts = await live.activity();
        return { ...facts, tools: 0 };
      },
      async fenceAdmissions() {
        if (!live) throw new Error("Native process control not attached");
        return live.fenceAdmissions();
      },
    };
    const bridge = createNativeProductionBridge({
      directory,
      runtime,
      targetId: options.installationId,
    });
    services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: options.zcodeBuiltinProviderConfigFilePath,
      serviceAuthorityMode: "standalone-server",
      agentHostTargetId: options.installationId,
      workspaceCompositionRoot: join(configRoot, "workspace-hierarchy"),
      workspaceComposition: bridge,
      initiallyHeld: options.admissionFence === "held",
      additionalTrustedHarnesses: options.additionalTrustedHarnesses,
    });
    const nativeService = services.get(IZCodeAgentService);
    live = getNativeProcessControlPort(nativeService);
    creation = getNativeCreationControlPort(nativeService);
    // 中文：session DB 只能由真实 CLI storage-startup 创建。显式在启动时使用
    // 配置解析所用 cwd 的 worker；不能让 sidebar 查询暗中启动迁移或制造空库。
    await nativeService.prepareStorage({ workspacePath: process.cwd() });
    const storage = await nativeService.getStorageStartupState({ workspacePath: process.cwd() });
    // 中文：只有 CLI 已打开的真实 storage owner 可说明自定义 cwd/env 的相对 DB；
    // Core 的 launch cwd 不能代替它。默认关闭创建时保持旧 worker 的只读启动兼容。
    if (nativeEnabled) {
      const bootOwner = await creation.describe({ workspacePath: process.cwd() });
      nativeDb = bootOwner.nativeDatabasePath;
    }
    // 中文：不带 storage-startup 控制帧的旧/自定义 CLI 会让 prepareStorage 立即
    // 返回；只有同一个配置路径的真实 CLI 完成写端迁移后，Core 才能发布只读目录。
    if (
      storage?.state?.phase !== "ready" ||
      storage.state.databaseId !== createHash("sha256").update(nativeDb).digest("hex")
    )
      throw new Error("Core native CLI storage owner unavailable or path changed");
    const collection = services;
    const coordinator = getWorkspaceMaintenanceCoordination(collection);
    if (!coordinator) throw new Error("Core maintenance coordinator missing");
    let disposing: Promise<void> | undefined;
    let disposed = false;
    const bootAdmissionLease =
      options.admissionFence === "held"
        ? {
            async release() {
              if (disposed) throw new Error("Core boot admission owner disposed");
              await getWorkspaceCompositionReady(collection);
              if (disposed) throw new Error("Core boot admission owner disposed");
              // 中文：同一 Core 的启动门禁只解除一次；维护租约依旧独立持有，不能被旧启动令牌清空。
              coordinator.releaseInitialHold();
            },
          }
        : undefined;
    return {
      services: collection,
      maintenance: {
        async freezeAdmissions() {
          const lease = await coordinator.freezeAdmissions();
          return { release: () => coordinator.releaseAdmissions(lease) };
        },
        async readActivity() {
          const facts = await live.activity();
          // 中文：Core IPC 的 strict schema 不接受进程端口的 offline 字段；不能让真实空闲事实变成未知回执。
          const native = {
            running: facts.running,
            waiting: facts.waiting,
            uncertain: facts.uncertain + (facts.offline ? 1 : 0),
          };
          const external = await collection
            .get((await import("./agent-host/serviceContract.js")).IAgentHostService)
            .getRuntimeActivity();
          return { native, external };
        },
      },
      reconcileBeforeAdmission: () => getWorkspaceCompositionReady(collection),
      ...(bootAdmissionLease ? { bootAdmissionLease } : {}),
      dispose() {
        disposed = true;
        return (disposing ??= (async () => {
          try {
            await disposeServiceResourcesAndWait(collection);
          } finally {
            await owner.close();
          }
        })());
      },
    };
  } catch (error) {
    try {
      if (services) await disposeServiceResourcesAndWait(services);
    } finally {
      await owner.close();
    }
    throw error;
  }
}
