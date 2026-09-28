# Wave 4 发布加固

这次只锁定已经接进集成分支的版本，并在临时目录里演练升级和回滚。不读取、不改写用户日常会话目录，不新造 SSH daemon。

## 版本锁定

| 组件 | 锁定值 | 位置 |
| --- | --- | --- |
| Model Gateway | `0.3.0` | `MODEL_GATEWAY_VERSION` |
| Codex adapter / 假 CLI 探针 | `0.157.1`（探针输出 `codex-cli 0.157.1`） | `CodexHarnessAdapter.version`、`PINNED_CODEX_CLI_VERSION` |
| Pi SDK 包与 Pi adapter | `0.87.1` | `@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`、`PiHarnessAdapter.version` |
| Claude Code adapter | `0.1.0` | `CLAUDE_CODE_ADAPTER_VERSION` |

升级这些版本时要同时改探针、adapter `version` 和对应测试里的 `adapterVersion`。只改其中一处会在规划阶段被拒绝。

## 升级与回滚

所有者仍是 `CatalogStore`。`legacyWorkspaceMigration.plan()` 不写 catalog。`apply()` 先把当前快照交给 `MigrationBackupWriter`，再提交映射。

演练使用 `mkdtemp` 下的假 catalog 文件，不使用用户主目录：

1. 写入空 catalog。
2. `apply()` 把迁移前快照写到旁边的备份文件，再写入旧会话映射。
3. 用备份文件覆盖 catalog。
4. 再次读取，项目和会话数量回到迁移前。

工作区路径字符串只作为映射输入。演练不删除 Git 目录、工作区文件或 native session 正文。

## 假传输压测

下面三项使用内存目录或临时 journal，循环 40 次。这不是多小时浸泡，也不是真实 SSH 或真实 Provider。

- 同一工作区三个会话，断线刷新后 id 还在，活动不会被改成 succeeded。
- 删除进行中，新会话被拒绝，目录和已有会话还在。
- `CommandJournal` 在未完成的 send 上关闭再打开，收据是 `execution-unknown`，同一条 prompt 不会再次被接受。

## 未运行

环境没有这些条件，本次不把它们写成通过：

- 真实 SSH 机器，以及关闭整个 Electron。
- 真实 Provider 的 live 调用。仓库里不写 Provider Key，也不写真实 Provider URL。
- 新的 SSH daemon、mosh 或 autossh。远程执行仍沿用现有 Supervisor / direct-tcpip。
