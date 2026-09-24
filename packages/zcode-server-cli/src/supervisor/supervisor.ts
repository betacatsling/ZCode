/* oxlint-disable eslint(max-lines) -- Supervisor 集中维护生命周期、Core 代际和更新回滚状态机，启动恢复锁边界修复不应拆散其原子流程。 */

import { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServiceLogger } from "@zcode/services/node";
import {
  coreMessageSchema,
  SERVER_CLI_PROTOCOL_VERSION,
  type ControlRequest,
  type LifecycleState,
  type ReleaseManifest,
  type RuntimeActivity,
  type ServerStatus,
} from "../contracts.js";
import { createControlServer, type ControlHandler } from "../ipc/controlServer.js";
import { ControlRequestError } from "../ipc/controlError.js";
import { DataRootLock } from "../runtime/lock.js";
import { resolveServerLayout, type ServerLayout } from "../runtime/paths.js";
import { ReleaseManager } from "../runtime/releaseManager.js";
import { createStatusPersister } from "../runtime/statusSnapshot.js";
import { recoverSupervisorStartup } from "../runtime/startupRecovery.js";
import { waitForUpdateReady } from "../runtime/updateReadiness.js";
import { createRollbackFailure, updateErrorMessage } from "../runtime/updateErrors.js";
import { CrashBudget } from "./crashBudget.js";
import { unsafeActivityCount } from "./activityGuard.js";

// 生命周期事件按运维排障判据用 info/warn/error（出问题时运维要能在日志里看到）；
// 高频 heartbeat/task-activity 明细走 debug，避免生产日志膨胀。
const log = createServiceLogger("server-supervisor");

interface CoreLauncher {
  launch(
    generation: number,
    release: ReleaseManifest | null,
    bootMode: "open" | "held",
  ): ChildProcess;
}

interface SupervisorOptions {
  layout?: ServerLayout;
  launcher: CoreLauncher;
  version: string;
  serviceRegistered?: boolean;
  /** 测试和诊断可缩短 ready 等待；生产默认保持 15 秒。 */
  coreReadyTimeoutMs?: number;
  /** 测试可缩短 Core 优雅退出和强杀后的终态等待；生产分别默认 5 秒和 2 秒。 */
  coreStopGraceTimeoutMs?: number;
  coreKillTimeoutMs?: number;
  now?: () => number;
  onStopped?: () => void;
}

type LifecycleOperationKind = "stop" | "restart" | "update" | "uninstall";

interface MaintenanceLease {
  token: object;
  unsafeCount: number;
  core: ChildProcess;
  generation: number;
  release(): Promise<void>;
}

export class Supervisor {
  private readonly layout: ServerLayout;
  private readonly lock: DataRootLock;
  private readonly crashBudget: CrashBudget;
  private readonly releaseManager: ReleaseManager;
  private core: ChildProcess | undefined;
  private bootFence: { core: ChildProcess; generation: number; leaseId: string } | undefined;
  private bootMode: "open" | "held" = "open";
  private deferredRestartGeneration: number | undefined;
  private control: Awaited<ReturnType<typeof createControlServer>> | undefined;
  private state: LifecycleState = "stopped";
  private generation = 0;
  private host: string | null = null;
  private port: number | null = null;
  private startedAt: number | null = null;
  private runningTaskCount = 0;
  private externalActivity: RuntimeActivity = { running: 0, waiting: 0, uncertain: 1 };
  private lastExitReason: string | null = null;
  private readonly persistStatusSnapshot: () => Promise<void>;
  private lifecycleOperation:
    | { kind: LifecycleOperationKind; promise: Promise<unknown> }
    | undefined;
  private activeRelease: ReleaseManifest | null = null;
  private fallbackMaintenance: MaintenanceLease | undefined;
  private maintenanceInFlight: object | undefined;
  private maintenanceHeld: object | undefined;

  public constructor(private readonly options: SupervisorOptions) {
    this.layout = options.layout ?? resolveServerLayout();
    this.lock = new DataRootLock(this.layout.lockFile);
    this.crashBudget = new CrashBudget({ now: options.now });
    this.releaseManager = new ReleaseManager(this.layout);
    this.persistStatusSnapshot = createStatusPersister(
      this.layout.statusFile,
      () => this.status(),
      (error) => log.warn("failed to persist status snapshot", error),
    );
  }

  public async start(): Promise<ServerStatus> {
    if (this.state === "ready" || this.state === "starting") return this.status();
    await this.releaseManager.ensure();
    await this.lock.acquire();
    try {
      // 启动恢复会回写 current.json 并删除 update-transaction.json，必须先取得
      // data-root 单实例锁；否则存活 Supervisor 的 apply-update 会与第二个启动者竞态，
      // 造成内存继续运行新 release、磁盘 current pointer 却被回滚到旧 release。
      await recoverSupervisorStartup(
        this.releaseManager,
        this.layout.uninstalledFile,
        this.layout.serverRoot,
        async (error) => {
          this.state = "stop-failed";
          this.lastExitReason = `update rollback recovery failed: ${updateErrorMessage(error)}`;
          await this.persistStatusSnapshot();
        },
      );
      // recovery 可能已经恢复 current pointer；必须在恢复后读取，避免启动已回滚的 candidate。
      this.activeRelease = await this.releaseManager.readCurrentForExecution();
      await mkdir(this.layout.runDir, { recursive: true, mode: 0o700 });
      const handler: ControlHandler = (request) => this.handleControl(request);
      this.control = await createControlServer(this.layout.controlEndpoint, handler);
      this.state = "starting";
      log.info("supervisor started", {
        serverRoot: this.layout.serverRoot,
        version: this.options.version,
      });
      this.launchCore();
      await this.persistStatusSnapshot();
      return this.status();
    } catch (error) {
      // 只在 recovery 失败时释放锁是不够的：mkdir、control server、Core 启动或
      // 初始状态落盘失败会留下锁（以及可能已启动的 Core），同一 Supervisor 重试会把
      // 自己识别成另一个实例。启动临界区必须在确认 Core/control 都收口后才释放锁。
      const recoveryFailed = this.state === "stop-failed";
      let coreStopped = this.core === undefined;
      if (this.core) {
        try {
          await this.stopCore("startup-failed");
          coreStopped = true;
        } catch (stopError) {
          log.error("failed to stop Core after supervisor startup failure", stopError);
        }
      }

      let controlClosed = this.control === undefined;
      if (this.control) {
        try {
          await this.control.close();
          this.control = undefined;
          controlClosed = true;
        } catch (closeError) {
          log.error("failed to close control server after supervisor startup failure", closeError);
        }
      }

      if (coreStopped && controlClosed) {
        // 恢复失败本身已经写入 stop-failed；即使没有 Core/control 需要收口，也保留该
        // 状态，让 status 继续暴露待人工处理的事务，同时释放锁允许同实例稍后重试。
        this.state = recoveryFailed ? "stop-failed" : "stopped";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stopped state after supervisor startup failure",
            snapshotError,
          );
        });
        await this.lock.release();
      } else {
        this.state = "stop-failed";
        await this.persistStatusSnapshot().catch((snapshotError) => {
          log.warn(
            "failed to persist stop-failed state after supervisor startup failure",
            snapshotError,
          );
        });
      }
      throw error;
    }
  }

  public async stop(reason = "requested"): Promise<ServerStatus> {
    return await this.runLifecycleOperation("stop", () => this.stopInternal(reason));
  }

  private async stopInternal(reason: string): Promise<ServerStatus> {
    if (!this.core) {
      this.state = "stopped";
      await this.persistStatusSnapshot();
      await this.control?.close();
      this.control = undefined;
      await this.lock.release();
      if (reason !== "restart") this.options.onStopped?.();
      return this.status();
    }
    await this.stopCore(reason);
    this.state = "stopped";
    await this.persistStatusSnapshot();
    await this.control?.close();
    this.control = undefined;
    await this.lock.release();
    log.info("supervisor stopped", { reason });
    if (reason !== "restart") this.options.onStopped?.();
    return this.status();
  }

  public async restart(): Promise<ServerStatus> {
    return await this.runLifecycleOperation("restart", async () => {
      await this.stopInternal("restart");
      return await this.start();
    });
  }

  private async stopCore(reason: string): Promise<void> {
    if (!this.core) return;
    this.state = "stopping";
    this.lastExitReason = reason;
    log.info("stopping server core", { reason, pid: this.core.pid });
    const core = this.core;
    try {
      await new Promise<void>((resolve, reject) => {
        // 发出 SIGKILL 后不能最多等两秒便无条件返回：未观察到子进程终态
        // 也会释放 data-root lock，随后可启动第二个 Core。只有 exit/close 能证明进程
        // 已收口；强杀后仍无终态必须失败并保留 Core 引用和锁。
        let killTimer: NodeJS.Timeout | undefined;
        let settled = false;
        const cleanup = (): void => {
          clearTimeout(graceTimer);
          if (killTimer) clearTimeout(killTimer);
          core.off("exit", finish);
          core.off("close", finish);
          core.off("error", handleError);
        };
        const finish = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        const fail = (): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(
            new Error(`Server Core pid ${core.pid ?? "unknown"} did not terminate after SIGKILL`),
          );
        };
        const handleError = (error: Error): void => {
          log.warn("server core emitted an error while stopping; awaiting exit or close", error);
        };
        const forceKill = (): void => {
          log.warn("server core did not exit within grace period, sending SIGKILL", {
            pid: core.pid,
          });
          core.kill("SIGKILL");
          if (!settled) killTimer = setTimeout(fail, this.options.coreKillTimeoutMs ?? 2_000);
        };
        const graceTimer = setTimeout(() => {
          forceKill();
        }, this.options.coreStopGraceTimeoutMs ?? 5_000);
        core.once("exit", finish);
        core.once("close", finish);
        core.once("error", handleError);
        try {
          core.send({ command: "shutdown" });
        } catch {
          // IPC 已关闭不代表 OS 进程已退出，直接强杀后仍等待 exit/close 终态。
          clearTimeout(graceTimer);
          forceKill();
        }
      });
    } catch (error) {
      if (this.core === core) {
        this.state = "stop-failed";
        this.lastExitReason = error instanceof Error ? error.message : String(error);
        await this.persistStatusSnapshot();
      }
      throw error;
    }
    if (this.core === core) {
      this.core = undefined;
      this.clearCoreScopedStatus();
    }
  }

  private async applyUpdate(force: boolean): Promise<unknown> {
    const pending = await this.releaseManager.readPending();
    if (!pending) throw new Error("No pending release is prepared");
    const maintenance = await this.beginMaintenance();
    if (!force && maintenance.unsafeCount > 0) {
      await maintenance.release();
      throw new Error("Active or uncertain tasks require --force for update");
    }
    try {
      return await this.applyUpdateWithLease(pending, force, maintenance);
    } finally {
      await maintenance.release();
    }
  }

  private async applyUpdateWithLease(
    pending: ReleaseManifest,
    force: boolean,
    maintenance: MaintenanceLease,
  ): Promise<unknown> {
    const previous = await this.releaseManager.readCurrent();
    let committed = false;
    // 中文：读指针是异步 IO，期间旧 Core 可能退出并被 crash timer 替换；
    // 原代际冻结不能授权停止新 Core，即使 --force 也必须重新验证身份。
    this.assertMaintenanceOwner(maintenance);
    log.info("applying pending release", { version: pending.version, force });
    await this.stopCore("update");
    this.state = "updating";
    await this.persistStatusSnapshot();
    try {
      await this.releaseManager.applyPendingWithTransaction(previous);
      this.activeRelease = pending;
      this.state = "starting";
      this.launchCore("held");
      await waitForUpdateReady(
        () => (this.bootFence ? "ready" : this.state),
        this.options.coreReadyTimeoutMs ?? 15_000,
      );
      const candidate = this.requireBootFence();
      await this.releaseManager.completeUpdate();
      committed = true;
      // 中文：commit 本身是异步 IO；只有同一代际还活着才可释放它的启动冻结。
      this.assertBootFence(candidate);
      await this.releaseBootFence(candidate);
      log.info("release applied", { version: pending.version });
      return { applied: true, version: pending.version };
    } catch (error) {
      if (committed) {
        // 中文：commit 后 release 回执丢失时，候选 Core 可能已开放并接收新请求；
        // 再回滚会无凭据地中断它。保留 current、锁和诊断，显式人工恢复。
        this.state = "stop-failed";
        this.lastExitReason = `committed update admission uncertain: ${updateErrorMessage(error)}`;
        await this.persistStatusSnapshot();
        throw error;
      }
      this.enterUpdateRollback();
      // 更新后的 Core 未 ready 时必须先停止仍存活的子进程，再恢复 current 指针。
      // 否则 timeout 路径会覆盖 this.core 引用后遗留新 Core，与回滚后的旧 Core 并存。
      if (this.core) {
        try {
          await this.stopCore("update-rollback");
        } catch (stopError) {
          log.error("failed to stop unhealthy release during rollback", stopError);
          await this.persistStatusSnapshot();
          throw stopError;
        }
      }
      // 恢复 current 指针，避免下一次启动继续使用坏 release。
      log.error("release apply failed, restoring previous current pointer", error);
      try {
        await this.releaseManager.restoreCurrent(previous);
        await this.releaseManager.completeUpdate();
      } catch (rollbackError: unknown) {
        this.state = "stop-failed";
        this.lastExitReason = `rollback pointer restore failed: ${updateErrorMessage(rollbackError)}`;
        await this.persistStatusSnapshot();
        throw createRollbackFailure(error, rollbackError);
      }
      this.activeRelease = previous;
      // 回滚不仅恢复 pointer，还要立即拉起旧 release；否则 daemon 会以 stopped 留在
      // 不可用状态，用户必须手工 restart 才能恢复服务。
      this.state = "stopped";
      if (previous) {
        this.state = "starting";
        this.launchCore("held");
        try {
          await waitForUpdateReady(
            () => (this.bootFence ? "ready" : this.state),
            this.options.coreReadyTimeoutMs ?? 15_000,
          );
          await this.releaseBootFence(this.requireBootFence());
        } catch (rollbackError) {
          log.error("previous release rollback failed", rollbackError);
          // 旧 release ready 超时只改状态会让仍存活的 Core、PID 和 lock 与 stopped 脱节；复用 stopCore 等待 exit/close，失败则保持 stop-failed。
          if (this.core) await this.stopCore("update-rollback");
          this.state = "stopped";
        }
      }
      await this.persistStatusSnapshot();
      throw error;
    }
  }

  public status(): ServerStatus {
    return {
      protocolVersion: SERVER_CLI_PROTOCOL_VERSION,
      state: this.state,
      pid: this.core?.pid ?? null,
      port: this.port,
      host: this.host,
      version: this.options.version,
      generation: this.generation,
      startedAt: this.startedAt,
      lastExitReason: this.lastExitReason,
      serviceRegistered: this.options.serviceRegistered ?? false,
      runningTaskCount: this.runningTaskCount,
      externalActivity: this.externalActivity,
      crashBudget: this.crashBudget.snapshot(),
      updatedAt: Date.now(),
    };
  }

  private launchCore(bootMode: "open" | "held" = "open"): void {
    const generation = ++this.generation;
    const child = this.options.launcher.launch(generation, this.activeRelease, bootMode);
    this.core = child;
    this.clearCoreScopedStatus();
    this.bootMode = bootMode;
    log.info("launching server core", { generation, pid: child.pid });
    child.on("message", (raw: unknown) => this.handleCoreMessage(child, generation, raw));
    let terminalObserved = false;
    let spawnErrorReason: string | undefined;
    const handleTerminal = (reason: string): void => {
      if (terminalObserved) return;
      terminalObserved = true;
      if (this.core !== child || this.state === "stopping" || this.state === "stopped") return;
      if (this.state === "stop-failed") {
        // stop 已失败时继续保留锁；迟到的终态只清除已死亡 child，不得计入 crash budget
        // 或启动替代 Core。用户重试 stop 后再释放 control socket 与 data-root lock。
        this.core = undefined;
        this.clearCoreScopedStatus();
        this.lastExitReason = reason;
        void this.persistStatusSnapshot();
        return;
      }
      this.core = undefined;
      this.clearCoreScopedStatus();
      this.state = "crashed";
      this.lastExitReason = reason;
      const decision = this.crashBudget.recordCrash();
      if (!decision.shouldRestart) {
        this.state = "crash-loop-stopped";
        log.error("server core crash budget exhausted, entering crash-loop-stopped", {
          lastExitReason: this.lastExitReason,
        });
        void this.persistStatusSnapshot();
        return;
      }
      log.warn("server core crashed, scheduling restart", {
        lastExitReason: this.lastExitReason,
        delayMs: decision.delayMs,
      });
      void this.persistStatusSnapshot();
      setTimeout(() => {
        if (this.state !== "crashed" || this.generation !== generation || this.core) return;
        if (this.lifecycleOperation) {
          this.deferredRestartGeneration = generation;
          return;
        }
        this.state = "starting";
        this.launchCore();
      }, decision.delayMs).unref();
    };
    // fork 的 execPath 不存在/不可执行时 Node 只发 error + close，不发 exit。
    // error 与 exit 必须共用一次性终态，否则未处理的 error 会杀死 Supervisor，并让更新
    // 已写入的新 current pointer 绕过 catch/rollback。
    child.once("error", (error: Error & { code?: string }) => {
      spawnErrorReason = `core spawn error code=${error.code ?? "unknown"}: ${error.message}`;
      this.lastExitReason = spawnErrorReason;
      log.error("server core process error", error);
      void this.persistStatusSnapshot();
    });
    child.once("exit", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core exited code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
    child.once("close", (code, signal) => {
      handleTerminal(
        spawnErrorReason ?? `core closed code=${code ?? "null"} signal=${signal ?? "none"}`,
      );
    });
  }

  private handleCoreMessage(child: ChildProcess, expectedGeneration: number, raw: unknown): void {
    // 旧 child 的 message listener 会跨 generation 存活，延迟 heartbeat/ready
    // 可覆盖当前 Core 的状态。消息必须同时绑定当前 child；ready 还需匹配启动 generation。
    if (this.core !== child) return;
    const parsed = coreMessageSchema.safeParse(raw);
    if (!parsed.success) {
      return;
    }
    const message = parsed.data;
    if (message.type === "ready") {
      // ready 只对当前 starting 的 Core 有效；stopping/stopped/stop-failed 阶段的迟到消息
      // 不能复活已经收口或进入不确定终态的 Supervisor。
      if (message.generation !== expectedGeneration || this.state !== "starting") return;
      if (this.bootMode === "held") {
        if (!message.bootLeaseId || this.bootFence) return;
        this.bootFence = {
          core: child,
          generation: expectedGeneration,
          leaseId: message.bootLeaseId,
        };
      } else {
        this.state = "ready";
      }
      this.host = message.host;
      this.port = message.port;
      this.generation = message.generation;
      this.startedAt = Date.now();
      log.info("server core ready", {
        host: this.host,
        port: this.port,
        generation: this.generation,
      });
    } else if (
      message.type === "heartbeat" ||
      message.type === "task-activity" ||
      message.type === "activity"
    ) {
      this.runningTaskCount = message.runningTaskCount;
      this.externalActivity = message.externalActivity ?? { running: 0, waiting: 0, uncertain: 1 };
      log.debug("core activity snapshot", {
        type: message.type,
        runningTaskCount: message.runningTaskCount,
      });
    } else if (message.type === "fatal") {
      this.lastExitReason = message.message;
      log.error("server core reported fatal error", { message: message.message });
    } else if (message.type === "exit") {
      this.lastExitReason = message.reason;
      log.info("server core reported exit", { reason: message.reason });
    }
    void this.persistStatusSnapshot();
  }

  private enterUpdateRollback(): void {
    // 候选 Core 崩溃后 handleTerminal 会将状态置为 crashed 并安排自动重启；
    // 回滚文件操作期间必须先离开 crashed，否则定时器会用坏的 activeRelease 再次拉起 Core。
    if (this.state === "crashed") this.state = "updating";
  }

  private clearCoreScopedStatus(): void {
    this.bootFence = undefined;
    this.bootMode = "open";
    this.deferredRestartGeneration = undefined;
    this.fallbackMaintenance = undefined;
    this.maintenanceHeld = undefined;
    this.maintenanceInFlight = undefined;
    this.host = null;
    this.port = null;
    this.startedAt = null;
    this.runningTaskCount = 0;
    // Core 代际死亡不是会话终态；新 Core 恢复/journal 核验之前不能声明 idle。
    this.externalActivity = { running: 0, waiting: 0, uncertain: 1 };
  }

  /** Freeze admissions before reading fresh native + external activity; a snapshot alone races new commands. */
  private requireBootFence(): { core: ChildProcess; generation: number; leaseId: string } {
    const fence = this.bootFence;
    if (!fence) throw new Error("Core boot generation lease missing; candidate remains unsafe");
    this.assertBootFence(fence);
    return fence;
  }

  private assertBootFence(fence: {
    core: ChildProcess;
    generation: number;
    leaseId: string;
  }): void {
    if (
      this.core !== fence.core ||
      this.generation !== fence.generation ||
      this.state !== "starting"
    )
      throw new Error("Core boot generation changed during update; candidate unsafe");
  }

  private async releaseBootFence(fence: {
    core: ChildProcess;
    generation: number;
    leaseId: string;
  }): Promise<void> {
    this.assertBootFence(fence);
    await this.releaseCoreLease(fence.core, fence.generation, fence.leaseId);
    this.assertBootFence(fence);
    if (this.bootFence === fence) {
      this.bootFence = undefined;
      this.state = "ready";
    }
  }

  private assertMaintenanceOwner(lease: MaintenanceLease): void {
    if (
      this.core !== lease.core ||
      this.generation !== lease.generation ||
      this.maintenanceHeld !== lease.token
    )
      throw new Error("Core generation changed since maintenance lease; operation unsafe");
  }

  private async beginMaintenance(): Promise<MaintenanceLease> {
    // 中文：冻结请求与 lease 的状态都必须以 token 比较；旧请求的 finally/迟到 release
    // 不能覆盖新代际的预留或已持有租约。
    if (this.maintenanceInFlight || this.maintenanceHeld)
      throw new Error("Core maintenance operation already in progress");
    const token = {};
    this.maintenanceInFlight = token;
    try {
      const lease = await this.requestMaintenance();
      if (this.maintenanceInFlight !== token)
        throw new Error("Core generation changed during maintenance acquire");
      this.maintenanceHeld = token;
      let released = false;
      return {
        ...lease,
        token,
        release: async () => {
          if (released) return;
          await lease.release();
          released = true;
          if (this.maintenanceHeld === token) this.maintenanceHeld = undefined;
        },
      };
    } finally {
      if (this.maintenanceInFlight === token) this.maintenanceInFlight = undefined;
    }
  }

  private async requestMaintenance(): Promise<Omit<MaintenanceLease, "token">> {
    const core = this.core;
    const generation = this.generation;
    if (!core || this.state !== "ready") throw new Error("Core unavailable for maintenance");
    const requestId = randomUUID();
    const reply = await new Promise<
      Extract<ReturnType<typeof coreMessageSchema.parse>, { type: "maintenance" }> | undefined
    >((resolve) => {
      let settled = false;
      const finish = (
        result?: Extract<ReturnType<typeof coreMessageSchema.parse>, { type: "maintenance" }>,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        core.off("message", onMessage);
        core.off("exit", onExit);
        core.off("close", onExit);
        resolve(result);
      };
      const onExit = (): void => finish();
      const onMessage = (raw: unknown): void => {
        const parsed = coreMessageSchema.safeParse(raw);
        if (
          parsed.success &&
          parsed.data.type === "maintenance" &&
          parsed.data.requestId === requestId
        )
          finish(parsed.data);
      };
      const timer = setTimeout(() => finish(), 2_000);
      core.on("message", onMessage);
      core.once("exit", onExit);
      core.once("close", onExit);
      try {
        core.send({ command: "maintenance-begin", requestId }, (error) => {
          if (error) finish();
        });
      } catch {
        finish();
      }
    });
    if (
      !reply?.leaseId ||
      !reply.nativeActivity ||
      !reply.externalActivity ||
      this.core !== core ||
      this.generation !== generation ||
      this.state !== "ready"
    ) {
      throw new Error("Cannot confirm maintenance admission fence; Core remains unsafe");
    }
    const leaseId = reply.leaseId;
    return {
      core,
      generation,
      unsafeCount:
        unsafeActivityCount(0, reply.nativeActivity) +
        unsafeActivityCount(0, reply.externalActivity),
      release: async () => {
        if (this.core !== core || this.generation !== generation) return; // 旧租约不可触及新代际。
        await this.releaseCoreLease(core, generation, leaseId);
      },
    };
  }

  private async releaseCoreLease(
    core: ChildProcess,
    generation: number,
    leaseId: string,
  ): Promise<void> {
    const releaseRequestId = randomUUID();
    const acknowledged = await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        core.off("message", onMessage);
        core.off("exit", onExit);
        core.off("close", onExit);
        resolve(ok);
      };
      const onExit = (): void => finish(false);
      const onMessage = (raw: unknown): void => {
        const parsed = coreMessageSchema.safeParse(raw);
        if (
          parsed.success &&
          parsed.data.type === "maintenance" &&
          parsed.data.requestId === releaseRequestId
        )
          finish(parsed.data.leaseId === leaseId);
      };
      const timer = setTimeout(() => finish(false), 2_000);
      core.on("message", onMessage);
      core.once("exit", onExit);
      core.once("close", onExit);
      try {
        core.send(
          { command: "maintenance-release", requestId: releaseRequestId, leaseId },
          (error) => {
            if (error) finish(false);
          },
        );
      } catch {
        finish(false);
      }
    });
    if (!acknowledged || this.core !== core || this.generation !== generation)
      throw new Error("Cannot verify maintenance admission release for Core generation");
  }

  /** Fresh Core roundtrip closes the heartbeat-to-update race after a command was admitted. */
  private async readUnsafeActivityCount(): Promise<number> {
    const core = this.core;
    if (!core || this.state !== "ready") return 1;
    const requestId = randomUUID();
    const activityCount = await new Promise<number | undefined>((resolve) => {
      let settled = false;
      const finish = (count: number | undefined): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        core.off("message", onMessage);
        core.off("exit", onExit);
        core.off("close", onExit);
        resolve(count);
      };
      const onExit = (): void => finish(undefined);
      const onMessage = (raw: unknown): void => {
        const parsed = coreMessageSchema.safeParse(raw);
        if (
          parsed.success &&
          parsed.data.type === "activity" &&
          parsed.data.requestId === requestId
        ) {
          finish(unsafeActivityCount(parsed.data.runningTaskCount, parsed.data.externalActivity));
        }
      };
      const timer = setTimeout(() => finish(undefined), 2_000);
      core.on("message", onMessage);
      core.once("exit", onExit);
      core.once("close", onExit);
      try {
        core.send({ command: "activity", requestId }, (error) => {
          if (error) finish(undefined);
        });
      } catch {
        finish(undefined);
      }
    });
    if (activityCount === undefined || this.core !== core || this.state !== "ready") {
      this.externalActivity = { running: 0, waiting: 0, uncertain: 1 };
      return 1;
    }
    return activityCount;
  }

  private async handleControl(request: ControlRequest): Promise<unknown> {
    switch (request.command) {
      case "ping":
        return { protocolVersion: SERVER_CLI_PROTOCOL_VERSION };
      case "status":
        return this.status();
      case "stop":
        this.startAcknowledgedLifecycleOperation("stop", () =>
          this.stopInternal("control request"),
        );
        return { stopping: true };
      case "restart":
        this.startAcknowledgedLifecycleOperation("restart", async () => {
          await this.stopInternal("restart");
          await this.start();
        });
        return { restarting: true };
      case "prepare-update":
        return {
          status: (await this.readUnsafeActivityCount()) ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "apply-update":
        return await this.runLifecycleOperation("update", () =>
          this.applyUpdate(request.force === true),
        );
      case "prepare-uninstall":
        return {
          status: (await this.readUnsafeActivityCount()) ? "blocked" : "ready",
          runningTaskCount: this.runningTaskCount,
        };
      case "begin-fallback-migration": {
        if (this.fallbackMaintenance) throw new Error("Fallback migration already fenced");
        const lease = await this.beginMaintenance();
        if (lease.unsafeCount > 0) {
          await lease.release();
          throw new Error(
            "Cannot migrate fallback server while tasks are active, waiting or uncertain",
          );
        }
        this.assertMaintenanceOwner(lease);
        this.fallbackMaintenance = lease;
        return { ready: true };
      }
      case "end-fallback-migration": {
        const lease = this.fallbackMaintenance;
        if (!lease) throw new Error("No fallback migration lease");
        await lease.release();
        if (this.fallbackMaintenance === lease) this.fallbackMaintenance = undefined;
        return { released: true };
      }
      case "confirm-uninstall":
        if (request.confirmation !== "DELETE")
          throw new Error("Uninstall confirmation must be DELETE");
        // uninstall 前需要检查运行任务：
        // prepare-uninstall 会返回 blocked 却没有任何调用方消费它，confirm-uninstall
        // 直接停 Core 删数据，运行中的任务会被无提示中断。这里在最后防线上强制 guard，
        // 有运行任务时返回结构化错误并保持原状态。
        const maintenance = await this.beginMaintenance();
        if (maintenance.unsafeCount > 0) {
          await maintenance.release();
          throw new Error(
            "Cannot uninstall while tasks are active, waiting or uncertain; stop the server first",
          );
        }
        this.assertMaintenanceOwner(maintenance);
        log.info("uninstall confirmed, stopping server");
        try {
          this.startAcknowledgedLifecycleOperation("uninstall", async () => {
            try {
              this.assertMaintenanceOwner(maintenance);
              await this.stopInternal("uninstall");
            } finally {
              // 中文：停止失败且 Core 仍存活时释放原 lease，避免冻结永久遗留；
              // Core 已终止则旧代际 lease 不可触及下一代。
              await maintenance.release();
            }
          });
        } catch (error) {
          await maintenance.release();
          throw error;
        }
        return { uninstalled: true };
    }
  }

  private runLifecycleOperation<T>(
    kind: LifecycleOperationKind,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertLifecycleOperationCanStart(kind);
    const active = this.lifecycleOperation;
    if (active) {
      return active.promise as Promise<T>;
    }
    const promise = Promise.resolve().then(operation);
    this.lifecycleOperation = { kind, promise };
    void promise.then(
      () => this.finishLifecycleOperation(promise),
      () => this.finishLifecycleOperation(promise),
    );
    return promise;
  }

  private finishLifecycleOperation(promise: Promise<unknown>): void {
    if (this.lifecycleOperation?.promise !== promise) return;
    this.lifecycleOperation = undefined;
    // 中文：更新租约未决时 Core 崩溃不能自动换代；待旧操作彻底结算后，
    // 才能使用已经确认终态的 crash budget 恢复。旧定时器不能复活新 owner。
    if (
      this.state === "crashed" &&
      !this.core &&
      this.deferredRestartGeneration === this.generation
    ) {
      this.state = "starting";
      this.launchCore();
      void this.persistStatusSnapshot();
    }
  }

  private startAcknowledgedLifecycleOperation(
    kind: LifecycleOperationKind,
    operation: () => Promise<unknown>,
  ): void {
    // ack 型请求也必须在回包前检查 gate；后台 Promise 再 reject 会让客户端误以为
    // restart/uninstall 已受理，实际却只在 Supervisor 日志里留下冲突。
    this.assertLifecycleOperationCanStart(kind);
    const started = this.runLifecycleOperation(kind, async () => {
      // control response 必须先写回原 socket；直接关闭 control server 会与 dispatch 互等。
      await new Promise<void>((resolve) => setImmediate(resolve));
      return await operation();
    });
    void started.catch((error: unknown) => {
      log.error(`lifecycle operation ${kind} failed`, error);
    });
  }

  private assertLifecycleOperationCanStart(kind: LifecycleOperationKind): void {
    const active = this.lifecycleOperation;
    if (!active || (kind === "stop" && active.kind === "stop")) return;
    throw new ControlRequestError(
      "operation-in-progress",
      `Lifecycle operation ${active.kind} is already in progress`,
      true,
    );
  }
}
