# 设置页 Coding Plan 购买面下线

状态：本刀只关设置页里仍依赖产品 OAuth / JWT 的购买、升级和登录恢复。不改 P4 凭据读取、Web 登录、Root/Welcome 全局 OAuth，也不改聊天输入栏用量计。

## 行为

- 设置页不再调用 `requestLoginEntry` 来连接 Coding Plan，也不再把购买中断后续到产品登录。
- `beginCodingPlanUpgradeLogin` 不接收、不调用 `requestLoginEntry`。登录成功后的恢复结果固定为丢弃，不会重开购买。
- 内嵌 Coding Plan webview 不再写入 `oauth:*:access_token` 或 `zcodejwttoken`。凭据 key 列表为空，注入脚本只删除这些 key。
- 设置页订阅、升级、续期、强制重新登录和套餐「管理」外链改为不再进入购买。订阅/升级/登录位置显示说明：产品登录和套餐购买已移除，请在模型设置中配置个人 API Key。
- 仍会打开升级弹窗的入口（设置页套餐横幅，以及复用同一弹窗的其它点击）只显示同一说明，不加载购买 webview，不注入产品 JWT。聊天输入栏文件未改。
- 个人 API Key 与自定义 Provider 的保存、测试和模板创建路径保持原所有者。

## 所有者

| 事实                            | 所有者                      | 本刀                                           |
| ------------------------------- | --------------------------- | ---------------------------------------------- |
| 设置页购买/升级是否可走产品登录 | 设置页升级弹窗与状态卡      | 关闭。弹窗只展示下线说明                       |
| 产品 OAuth 会话与全局登出       | Root / Welcome / `useOAuth` | 不改                                           |
| 个人 Provider 配置              | Provider Config Runtime     | 不改                                           |
| 聊天输入栏用量展示              | `chat-input-toolbar`        | 不改文件。共享升级弹窗若被点开，只显示下线说明 |

## 事件顺序

```text
设置页点击订阅 / 升级 / 登录恢复
  → 状态卡文案，或升级弹窗文案
  → 不调用 requestLoginEntry
  → 不向 webview 注入产品 JWT / OAuth key
```

没有第二份购买队列。弹窗不保存订单或登录尝试。
