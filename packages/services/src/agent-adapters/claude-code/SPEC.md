# Claude Code adapter

计划：`ZCode_Multi_Harness_Refactor_Plan_v0.3_Orca_Hierarchy.md` 第 6 节 P5。本目录是独立实现，不复制 CodexHost 源码，不修改公共契约，也不启动用户机器上的 Claude 登录配置。

## 行为

- 控制面把假传输或 ACP 传输上的结构化事件翻译成 `@zcode/shared/agent-host` 的 `AgentEvent`。
- 模型面只询问注入的 `ClaudeCodeModelBindingPort`。端口 mock 不是现有模型执行层。
- 接通 ACP 只表示传输层有会话。它不能把 `host-managed` 标成已认证，也不能表示该 Harness 接受宿主的任意模型。
- 没有 Claude 凭据时使用假传输。不读取、不写入 `~/.claude` 或 `CLAUDE_CONFIG_DIR`。
- 同一 `workspaceIdentity` 可以有多个 `hostSessionId`。关闭一个会话不关闭其他会话仍在使用的传输。

## 所有者

`ClaudeCodeHarnessAdapter` 拥有本适配器内的会话表、序号、活动轮次和未决审批。宿主的 journal、准入和 UI 焦点不在这里。

```text
command → ClaudeCodeHarnessAdapter → 单个会话状态 → 假传输/ACP 传输
                         └ 模型询问只进入注入端口，不进入传输
```

## 不变量

- 缓存和取消键是 `hostSessionId` + `runtimeEpoch` + `turnId`，不是 workspace + harness。
- 事件序号按会话单调递增。相同 `sourceEventId` 丢弃。序号缺口不补造文本，轮次以 `unknown` 结束。
- `message.finished` 是完整快照，不再追加一份相同正文。
- 晚到的 cancel / approval 必须命中原 epoch、turn、interaction，否则拒绝且不改变活动轮次。
- 拒绝审批后不再投递该轮后续的工具成功事件。
- `host-managed` 只有在端口证据 `kind === "model-execution-layer"` 且生效模型与请求一致时，才可以是 `supported`。否则路线记为 `harness-managed`，支持度记为 `experimental` 或 `unsupported`（模型不一致时拒绝降级）。
- 不支持的能力返回 `{ support: "unsupported", reason }`。
- 配置标记和事件不包含 API key。调用方传入的机密字符串会被替换成 `[redacted]`。

## 失败语义

- 目标不可用、平台不匹配、非本地目标：`unsupported`。
- 重复 `hostSessionId`：`duplicate-id`。
- 过期 epoch / turn / interaction：对应的 stale 错误，不终止另一个会话。
- 并发第二轮：拒绝，不替换活动轮次。
- 全局 Claude 配置路径：在写入前抛出，不创建文件。

## 迁移边界

本模块不注册进默认组合，不改 Gateway、Host、UI 或共享契约。Gateway 与契约 PR #2 落地前，`host-managed` 保持未认证。
