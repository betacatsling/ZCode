# 原生 ZCode 会话路由

来源：计划第 3.3 节 facade、第 6 节 P2、第 7 节 PR 03。类型只使用 `@zcode/shared` 与 `@zcode/shared/agent-host` 已发布入口。不新增 SessionId、能力字段或契约 schema。

## 所有者

- 原生 ZCode 会话的命令、投影和模型执行只有现有 V4 owner 可写。
- `SessionRouter` 只做路由判断，不保存第二份会话队列。
- `ZCodeHarnessAdapter` 把命令交给注入的 V4 port。它不写 manifest、命令日志或事件日志。
- 外部会话的持久化仍由已有 `CommandJournal` / `EventJournal` / `SessionHost` 负责。本适配器拒绝被 `SessionHost` 挂成第二个 owner。

## 路由

```text
旧记录无 harness、provider 缺省或 provider=glm、且不是导入历史
  → harness=zcode，route=native V4
  → 缺省 provider 不补写成 glm
显式 harness=zcode 或 sidecar harnessId=zcode
  → native V4，不进入外部 SessionHost
未知 provider / harnessId=glm
  → unresolved unknown-backend，不改写成 glm，也不标成 zcode
migrationSource 存在
  → imported-history，不标成 zcode
同一 workspaceId + harness 的多个 hostSessionId
  → 全部保留；缓存与去重键是 hostSessionId
关闭外部准入
  → 只拒绝新建外部会话；已有外部会话仍回到原 owner
```

工作区归属调用 Project Catalog / Worktree 服务（PR #5）的 `createAgentSession`、`readExecution`、`listSessions`。本模块不发现、不新建、不删除 worktree。同一已接管工作区可以再开会话；删除期间该服务返回 `deletion-admission-rejected`，路由在写 manifest 或派发 V4 之前失败。旧会话的 harness 在这里读取，workspaceId 只从该服务的执行位置取得。

## 命令顺序

```text
dispatchNative: query receipt → 已存在则停止
              → port.admit（V4 持久化）→ 仅 accepted 才 port.dispatch
reconnect:    query receipt only
```

`accepted` 不是完成。重启后仍是 `execution-unknown` 的 prompt 不能再次派发。`detach` 只取消订阅，不终止 V4。

## 失败

- 同一记录里 `sessionId` 与 `taskId` 不一致：拒绝，不挑选其中一个。
- sidecar `hostSessionId` 与记录身份不一致：拒绝。
- 未注入 worktree 服务就创建或定位会话：`workspace-ownership-unavailable`。
- 执行位置不可准入，或与 spec 上的 target、workspace、worktree 不一致：拒绝，不写 manifest。
- `SessionHost.create/open` 见到 `harness.id=zcode`：在写 manifest 之前拒绝。
