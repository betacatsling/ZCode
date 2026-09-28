export type AttachmentCloseReason =
  | "window-close"
  | "gui-quit"
  | "ssh-disconnect"
  | "explicit-stop";

export interface AttachmentClosePlan {
  readonly closeRpcScope: boolean;
  readonly closeTunnel: boolean;
  readonly stopSupervisor: boolean;
  readonly stopWorkers: boolean;
}

/** `connection-exec` 是 IRemoteBackend.exec() 的前台 stdio，随 SSH channel 结束，不是常驻 Core。 */
export function assertResidentLifetime(lifetime: "resident-service" | "connection-exec"): void {
  if (lifetime !== "resident-service") {
    throw new Error("connection-exec-not-persistent");
  }
}

/**
 * 窗口关闭、GUI 退出、SSH 断开只关闭附着。
 * SSH 附着是 direct-tcpip 到目标 loopback Core；关掉隧道不等于停止 Core。
 * Model Gateway 与该 Core 同寿命：ssh-disconnect 不关闭 Gateway，也不撤销 grant。
 * 停止任务必须走 explicit-stop；Core dispose 才会关掉共享 Gateway。
 */
export function planAttachmentClose(reason: AttachmentCloseReason): AttachmentClosePlan {
  if (reason === "explicit-stop") {
    return {
      closeRpcScope: true,
      closeTunnel: true,
      stopSupervisor: true,
      stopWorkers: true,
    };
  }
  return {
    closeRpcScope: true,
    closeTunnel: reason === "ssh-disconnect",
    stopSupervisor: false,
    stopWorkers: false,
  };
}
