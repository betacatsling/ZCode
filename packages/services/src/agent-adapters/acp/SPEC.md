# ACP 接入规格

来源：`ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` 第 6 节 P6 与第 4.1 节。ACP 只是 Harness 接入策略之一。本目录不修改公共会话状态机、注册表、共享契约或 UI。

## 所有者

- `AcpSessionMachine` 是唯一的 ACP 连接状态所有者：协议版本、原生 `sessionId`、当前轮次、待审批请求、已发出的宿主事件。
- 宿主仍然拥有 `hostSessionId`、命令准入和事件日志。适配器不保留第二份已接受命令队列。
- Agent 档案（manifest、安装提示、模型绑定政策）只描述产品，不拥有会话，也不决定 `session/load` 是否存在。

## 行为

1. 客户端在 `initialize` 中提供已知的最高协议版本。稳定合同只有版本 1。版本 2 改变了 `session/load` 与 prompt 完成语义，协商到 2 或未知版本时，整次连接回到 `experimental`，不创建会话，也不调用 session 方法。
2. `session/load` 与 `session/resume` 只在本次 `initialize` 结果里出现时才可用。OpenCode、Goose 或其他品牌都不能缺省成“支持续跑”。
3. `viewHistory` 只返回本连接已经发出的宿主事件，不向 Agent 发送任何方法。不支持续跑时仍可查看这些历史。
4. 续跑失败时不得改叫 `session/new` 或重放 prompt。`attach` 同样如此。
5. `session/load` 进行中的 `session/update` 视为回放，不写入宿主正文，避免和已有历史重复。
6. 未知 `sessionUpdate`、`_` 扩展方法和客户端文件/终端方法拒绝执行。扩展只变成 `extension.event` 或 JSON-RPC 错误。
7. 半截 JSON 不作为最终工具参数。推理 chunk 不写入助手正文。
8. 宿主托管模型未认证。只接受 `harness-managed`。广告了认证方法时不提交凭据，探测结果为 `unsupported`。
9. 第二个同协议 Agent 只增加档案。公共状态机文件不得出现产品名。

## 事件顺序

```text
initialize → 能力协商
  ├─ experimental / 需要认证 → 停止，不 session/new
  ├─ create → session/new → prompt / cancel / permission
  ├─ resume（仅协商成功）→ session/load 或 session/resume
  └─ viewHistory → 只读已发出事件
```

幂等：带稳定 source id 的更新只生效一次。取消只作用于当前 turn。审批只作用于原 interaction。

## 失败

- 未协商续跑：`unsupported`，传输上不出现 load、resume、new、prompt。
- 协议版本改变：`experimental`，不准入。
- 传输中断且轮次未结束：`turn.finished` outcome `unknown`，不重发 prompt。
- 安装探测只报告可执行文件是否存在，不启动 Agent，也不据此推断 session 能力。

## 迁移边界

不改 `harnessRegistry`、共享契约和公共 UI。回滚是不注册对应 harness id。不把旧 native session 静默迁到另一协议版本。
