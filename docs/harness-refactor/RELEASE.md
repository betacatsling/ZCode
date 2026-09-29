# 发布锁定

## 当前集成 tip 复核

本 fixture 已在 `cursor/wave4-harness-integration-b7a9` tip `0ab129e9c7389f6d76324b314fe8b25f87b49623`（2026-09-30）重新运行：

```text
corepack pnpm exec tsx --test packages/services/src/agent-host/release/releaseDrill.test.ts
7 tests / 7 pass / 0 fail / 0 skipped
```

这是隔离的 macOS-local fixture 复核，不是 macOS 安装包、launchd、SSH、GUI 或真实 Provider 认证；release 目录没有被任何生产启动入口导入。

合成基线是 PR #15。这里只记录已经接进集成分支的契约版本，并在临时目录里演练 macOS 本机的升级和回滚。不新增 schema 字段，不改模型路由，不改已有的 Linux、Windows、WSL 或 systemd 实现。

## 验收平台

验收平台是 macOS 本机。Supervisor 仍用现有 launchd。功能开关只影响新建会话，不重新接管正在运行的会话。

临时目录里的升级、回滚和假传输可以在 CI 上跑逻辑。那不是 Linux SSH 验收，也不是 systemd、Windows 或 WSL 验收。不新造 SSH daemon。远程执行仍沿用现有 Supervisor。

## 版本锁定

| 组件                         | 锁定值              | 位置                                                                                   |
| ---------------------------- | ------------------- | -------------------------------------------------------------------------------------- |
| Model Gateway                | `0.3.0`             | `MODEL_GATEWAY_VERSION`                                                                |
| Codex adapter                | `0.157.1`           | `CodexHarnessAdapter.version`                                                          |
| Codex CLI 探针               | `codex-cli 0.157.1` | `PINNED_CODEX_CLI_VERSION`                                                             |
| Pi SDK 包与 Pi adapter       | `0.87.1`            | `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`PiHarnessAdapter.version` |
| Claude Code adapter          | `0.1.0`             | `CLAUDE_CODE_ADAPTER_VERSION`                                                          |
| Claude CLI 探针              | `2.1.263`           | `PINNED_CLAUDE_CLI_VERSION`                                                            |
| ACP adapter                  | `0.1.0`             | `ACP_ADAPTER_VERSION`                                                                  |
| ACP 协议                     | 稳定 `1`，提供 `2`  | `ACP_STABLE_PROTOCOL_VERSION`、`ACP_OFFERED_PROTOCOL_VERSION`                          |
| 原生 ZCode adapter           | `native-v4`         | `ZCODE_ADAPTER_VERSION`                                                                |
| SessionSpec                  | `1` 与 `2`          | `sessionSpecSchema`、`sessionSpecV2Schema`                                             |
| 外部会话 metadata            | `1`                 | `agentHostSessionMetadataSchema`                                                       |
| Session hierarchy sidecar    | `1`                 | `sessionHierarchyFileSchema`                                                           |
| Project / binding / worktree | `1`                 | `projectSchema` 等已有字面量                                                           |
| V4 wire                      | `3`                 | `V4_WIRE_PROTOCOL_VERSION`、`ZCODE_PROTOCOL_V4_WIRE_VERSION`                           |
| ZCode protocol               | `1`                 | `ZCODE_PROTOCOL_VERSION`                                                               |

升级这些版本时要同时改探针、adapter `version` 和 `packages/services/src/agent-host/release/versionLock.ts`。只改其中一处会在锁定测试里失败。

## 升级与回滚

所有者仍是原生会话文件的备份，以及现有的 `readLegacyZCodeSession` 分类。演练不写第二份已接受命令队列。

旧程序把缺少 sidecar 的记录当成原生 zcode。外部会话只写入 `external-sessions.json`，使用已有的 metadata `schemaVersion: 1`。原生文件先备份，升级不改它的字节。

演练使用 `mkdtemp` 下的临时目录，不使用用户主目录，不读日常会话，不读凭据：

1. 写入只含原生会话的 `native-sessions.json`。
2. 备份该文件。
3. 把外部会话写到旁边的 sidecar。带 metadata 的记录分类为 external，不进入原生重放。
4. 用备份覆盖原生文件。
5. 再次读取。旧程序的原生重放名单回到升级前，不包含外部会话，也不包含回滚前被塞进原生文件的记录。

未知字段通不过现有 strict schema，写入在替换文件之前失败。工作区路径字符串只作为映射输入。演练不删除 Git 目录、工作区文件或 native session 正文。

## 假传输

下面两项使用临时目录里的 `CommandJournal`，循环 40 次。传输是内存对象，验收语义是 macOS 本机 launchd。这不是多小时浸泡，也不是真实 SSH 或真实 Provider。

- 同一工作区三个会话。断线再打开后，未完成 send 的收据是 `execution-unknown`，同一条 prompt 不会再次派发。活动保持 `running`，不会被改成 succeeded。
- 删除进行中，新会话被拒绝。已有会话还在。

## 未运行

环境没有这些条件，本次不把它们写成通过：

- 真实 macOS 机器上的 launchd 安装与 GUI 退出。
- 真实 Provider 的 live 调用。仓库里不写 Provider Key，也不写真实 Provider URL。
- 新的 SSH daemon、mosh 或 autossh。
