# 产品登录与启动解耦（P1）

状态：P1 行为。不删除 `packages/services/src/oauth/`，也不实现 P2–P5。

## 行为

- 全新数据目录、离线、没有产品账号时，应用可以打开工作区、历史和设置。
- 启动渲染不等待产品 user、OAuth 会话恢复或 `providerFamilyDomain`。
- 模型目录读取失败继续显示现有加载错误和重试，不能改写成产品登录页。
- 缺少可执行模型只阻止需要模型的发送/创建。这些入口不打开产品登录。
- 侧栏原账号头像入口改为「模型与 Harness 设置」，打开现有模型设置。该入口不再提供登录、退出、过期重登录、Coding Plan 购买或团队按钮。语言、主题、界面模式和桌面缩放仍留在同一栏的偏好菜单。
- 个人 API Key、自定义 endpoint 和初始模型在现有模型设置里配置，不限于 Z.ai / BigModel 两家模板。配置写入既有 Provider Settings，不另建登录态。

## 所有者

| 事实 | 所有者 | UI |
| --- | --- | --- |
| 个人 Provider、endpoint、API Key、模型 | 目标端 Provider Settings / Registry | 模型设置提交草稿，不推断登录态 |
| 启动是否进入工作区 | Root 的 workspace/tab 恢复 | 只等待模型视图读取结束或失败，以及既有 tab/workspace 引导 |
| 产品 OAuth 会话 | 既有 OAuth service（P2 再拆） | P1 不把恢复结果当成启动门禁或全屏登录页 |

## 不变量

- 不伪造已登录用户，不加永久跳过登录开关。
- 模型视图的过期结果仍由现有 revision 丢弃；本变更不改 owner/lease。
- MCP OAuth、harness 自身认证、SSH/Web token、审批和 workspace admission 保持原契约。
- 设置页里尚未拆除的 Coding Plan 登录请求仍可能打开既有 WelcomeScreen。那是 P2 的服务与商业 UI 拆除范围，不是缺模型时的启动跳转。
