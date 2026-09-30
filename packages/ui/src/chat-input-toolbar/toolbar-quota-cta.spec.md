# 聊天工具栏额度：卸掉 Coding Plan 升级与产品登录

状态：只切断 composer 工具栏 / context 额度浮层上的购买升级和产品登录文案。升级弹窗 Dialog/Provider 已整卸；本刀不改设置页、Root/Welcome、侧栏用量摘要。

## 行为

- 工具栏 Start Plan 余额只读展示。不再传入 `onUpgradeClick`，也不调用 `openCodingPlanUpgrade`。
- `StartPlanContextBalance` 不再渲染升级按钮。额度条、刷新中状态和 hover access 刷新保留。
- context 浮层不再包装升级点击。
- Coding Plan 额度在 toolbar 路径上，`unavailableReason === "not_authenticated"` 使用「产品登录已移除 / 请在设置配置 API Key」。不提示去 OAuth 登录。
- 「更多」仍可打开设置里的用量页，且不触发产品登录。
- 侧栏共用的 `CodingPlanUsageRemainingPanel` 文案不改。

## 所有者

| 事实                   | 所有者                                              | 本刀               |
| ---------------------- | --------------------------------------------------- | ------------------ |
| 工具栏是否打开购买升级 | `V4ComposerToolbar` 接线                            | 不再发出升级命令   |
| 额度快照与刷新         | 既有 entitlement hook                               | 只读展示，不改请求 |
| 升级弹窗实现           | 原设置页 `CodingPlanUpgradeDialog*`（已整卸）       | 已整卸；本刀不涉及 |
| 侧栏用量摘要文案       | `WorkspaceSidebarFooterUsageSummary` / 共享剩余面板 | 不改               |

## 事件顺序

```text
hover context 额度
  → 只读表计，或 not_authenticated 的 API Key 文案
  → 不调用 openCodingPlanUpgrade
  → 「更多」仍只打开设置用量页
```

没有第二份升级队列。工具栏不保存购买或登录尝试。
