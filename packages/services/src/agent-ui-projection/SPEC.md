# ZCode V4 UI Projector

把标准 Host 事件投影成现有 V4 可消费的快照和增量。本目录是读模型，不拥有会话、不发送 prompt、不执行工具、不批准交互。

## 所有者

- 权威事件、命令接收和 runtime epoch 属于 Runtime Host。
- 本目录只从已提交的 `AgentEvent` 日志派生 V4 读模型。
- `conversationPublisher` / `sessionsIndexPublisher` 只记住订阅水位，不保存第二份事件队列。

## 交付

```text
desktop-continuous ── 连续 delta ──┐
                                   ├─ 同一 hostSession / runtimeEpoch / sequence
web-remote-replayable ─ snapshot + gap repair ┘
```

- snapshot 帧 `fromSeq = 0`，消费者整体替换本地快照，不与旧快照合并。
- delta 帧满足 `fromSeq === 已应用水位` 且 `toSeq` 为新水位，区间是 `(fromSeq, toSeq]`。
- 事件序号空洞、外会话事件、客户端水位对不上、epoch 变化，或增量表达不了窗口淘汰时，不发跳号 delta。调用方重订阅；能重建时改发 snapshot，日志本身断档时不发明缺失事件。
- `message.finished` 用整行替换收口，不把终态文本再追加到已经展示的 delta 后面。
- 工具参数只在 `tool.finished` 且 `inputText` 是完整 JSON 时写入 `input`。半截 JSON 保持 `input` 缺席。
- `plan.updated`、`subagent.updated`、`file.changed` 的路径、`session.error.message`、`extension.event` 的 namespace/version 必须出现在投影里。扩展 payload 只作为不可执行的展示文本，不写入工具 `input`。
- fork、compact、切模型、follow-up、队列编辑、立即发送队列、暂停/恢复 goal 一律 `{ allowed: false, reasonCode: "externalHarnessUnsupported" }`。翻译 V4 命令时，带这些字段的请求整单拒绝，不丢字段后降级执行。

## 不变量

- 投影输入的 sequence 必须从 1 连续。重复、乱序和空洞拒绝。
- 迟到的旧 turn 审批不能清除更新的 pending interaction。
- 未知扩展事件不能变成可执行 UI。
- 不迁移 Codex Desktop UI，不新增契约字段。
