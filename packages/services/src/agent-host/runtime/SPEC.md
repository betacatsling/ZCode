# Runtime Host owner fence

状态所有者是目标机上已经存在的 Server Core。Core 由现有 Supervisor（`server-cli serve --daemon`、launchd/systemd）拉起。SSH 附着复用 `connect.ts` 里的 `direct-tcpip`，经 `persistentTargetClient` 只关闭本 RPC scope 和隧道。本模块不创建第二个 daemon，不引入 mosh、autossh 或另一套远程服务器，也不把 `IRemoteBackend.exec()` 的前台 stdio 当成生命周期。

CodexHost（`BytePioneer-AI/codex-host@d9fa7aa`，LGPL-3.0-only）只作参考：会话身份、命令先持久化、断线不重放。这里没有复制它的源码或依赖。命令真相仍是现有 CommandJournal。

## 所有者

- Supervisor 持有 data-root lock、Core generation 和 `runningTaskCount`。
- Core 持有外部 AgentHost。每个 `hostSessionId` 在 Core 进程内再拿一把跨进程 owner fence。
- CommandJournal / EventJournal 仍是命令和事件的唯一写入者。fence 只拒绝第二个 owner，不重放 prompt。

## 事件顺序

```text
create/attach
  → 同一 hostSessionId 的进程内 admission 队列
  → owner fence（活着的 pid 拒绝；死亡 pid 只把 fence+1 接管，不 spawn）
  → SessionHost 持久化 accepted
  → 派发
窗口关闭 / GUI 退出 / SSH 断开
  → 关闭 RPC scope；SSH 额外关闭 direct-tcpip 隧道
  → 不调用 Supervisor stop，不把 Agent 标成 stopped/completed
显式 stop
  → 独立操作，才允许停止 Core
Core 崩溃后的新 generation
  → 旧 pid 已死才接管 fence
  → 未确认的 accepted send 仍是 execution-unknown，禁止再派发
```

## 不变量

- 身份是 `targetId + hostSessionId`。同一工作区路径落在不同 target 上不能共用 fence。
- stale fence 的写入直接失败，不能先删掉新 owner 的锁。
- 外部活动：`busy`、`unknown` 和索引不确定都计入 Supervisor 的 running count；`idle` 不计。客户端是否连着不参与计数。
