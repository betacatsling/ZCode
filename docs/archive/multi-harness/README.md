# Multi-harness 历史证据归档

`8d5d32b/` 保存整合审计前的历史材料，不代表当前状态，也不是对开发 Agent 的现行指令。

- 源码快照：`8d5d32b3bee0242a3f68ed2b79b4796fe0bd1bb6`。
- `8d5d32b/.tmp/`：从候选树移来的 25 个已跟踪 handoff、review 和兼容 patch；未删除其他 worktree 的文件。
- `8d5d32b/docs/`：清理前的 10 份文档完整副本，现行文件仍在正常 docs 路径。
- [manifest.json](8d5d32b/manifest.json) 逐文件记录原路径、归档路径、操作和 SHA-256；归档时已核对字节一致。

## 如何使用

当前入口是 [agent-host/README](../../agent-host/README.md)，状态以 [ACCEPTANCE](../../agent-host/ACCEPTANCE.md) 为准。

历史文档中的“当前”“必须保持 typecheck 失败”“缺少工厂/侧栏”等话语只描述当时阶段。后续实现可能已解决；不能从历史结论倒推当前缺失，也不能依旧指令恢复过时代码。

为保留原证据，归档内容未重写链接、临时日志地址或 PASS 描述。相对路径按 `manifest.json` 的原路径和源码 commit 解释；外部 `/tmp` 日志可能已经不存在。没有原日志的 PASS 是历史作者报告，不是本轮复现。

兼容 patch 只保留用于考古；应用前必须检查后续等价提交、所有者边界和具体测试。不得自动批量应用。
