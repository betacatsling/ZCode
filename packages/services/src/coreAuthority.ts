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
import { getNativeProcessControlPort } from "./zcode-agent/zcodeAgentService.js";
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
    const nativeDb = resolveNativeSessionDbPath({ cwd: process.cwd(), env: process.env });
    const taskDb = getTasksIndexDatabasePath();
    // 中文：旧工厂把首次 sidebar 的缺库误当只读故障；在 Core 持有 profile writer
    // 的启动写阶段运行同一 tasks migration owner，读路径本身绝不迁移。
    await prepareTasksIndexStorage(taskDb, () => {});
    const backups = join(configRoot, "native-migration", "backups");
    const metadata = new NativeSqliteMetadataReader(
      new ReadonlyNativeSessionMetadataView(nativeDb),
      async () => options.installationId,
    );
    const reader = new NativePersistentSessionIndex(
      taskDb,
      backups,
      options.installationId,
      metadata,
    );
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
      nativeSessionDatabasePath: nativeDb,
      backupDirectory: backups,
      profileId: options.installationId,
      listMappings,
    });
    // The live native process port binds to the real service after collection construction.
    let live: ReturnType<typeof getNativeProcessControlPort> | undefined;
    const runtime: NativeRuntimeFactsPort = {
      // 中文：V4 原生 durable create 收据/sidecar 写入尚无已认证路径；禁止声明可创建。
      async create() {
        throw new Error("Native durable creation receipt unavailable");
      },
      async capabilities() {
        throw new Error("Native capabilities unavailable without certified owner");
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
      additionalTrustedHarnesses: options.additionalTrustedHarnesses,
    });
    const nativeService = services.get(IZCodeAgentService);
    live = getNativeProcessControlPort(nativeService);
    // 中文：session DB 只能由真实 CLI storage-startup 创建。显式在启动时使用
    // 配置解析所用 cwd 的 worker；不能让 sidebar 查询暗中启动迁移或制造空库。
    await nativeService.prepareStorage({ workspacePath: process.cwd() });
    const storage = await nativeService.getStorageStartupState({ workspacePath: process.cwd() });
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
      dispose() {
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
