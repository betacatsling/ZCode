# P2：服务装配和账号派生能力拆除

状态：本变更已按下列边界实施。对照 `REMOVE-PRODUCT-LOGIN-PLAN.md` §2、§4、§P2。

## 行为

空闲启动的 Local Host 与 desktop-attached remote workspace 集合不再构造或注册：

- `IOAuthService` / `OAuthCredentialRepo` / 产品 JWT 401 → 全局 logout
- accountProvider 凭据、连接解析、请求鉴权与失效刷新
- `ICodingPlanSubscriptionService`

个人 API Key 的 `createCredentialService`、`createProviderConfigRuntime`、模型执行器与 harness 自身认证保持原所有者。账号 Provider 目录使用 `ProviderRuntime` 的 `EmptyAccountProviderConfigSource` fail-closed，不发起套餐或派生 Key 请求。历史消息里的模型标识仍由既有 Registry/记录读取，本阶段不擦除凭据库。

## 所有者

| 事实                                            | 所有者                                        | 本阶段                                                                                                                                                  |
| ----------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 个人 Provider 配置与可执行视图                  | Provider Config Runtime / Registry            | 继续由 `IProviderSettingsService`、`IModelSelectionService` 发布                                                                                        |
| 产品 OAuth 会话、派生 Coding Plan Key、订阅快照 | 原 OAuth / accountProvider / Coding Plan 服务 | 不再创建。旧 RPC 频道 `oauth`、`coding-plan-subscription` 不注册，未知频道按不兼容失败，不降级为匿名访问                                                |
| 官方 Server MCP 产品身份头                      | `resolveOfficialMcpCredentials`               | 固定 `official_auth_plan_required`，不读产品 JWT                                                                                                        |
| 闲时任务派发凭据                                | `resolveOffPeakCredentials`                   | 非 mock 直接 `connection_unavailable`；本地任务服务仍注册                                                                                               |
| 云分享 token                                    | ConversationShareHttpClient.tokenProvider     | 返回 null；缺 token 时客户端报 `authentication_required`                                                                                                |
| onboarding userId                               | `createOnboardingRecordService`               | `loadUserId` 固定 null                                                                                                                                  |
| 动态工作流灰度                                  | renderer store / host config                  | 不请求订阅服务。Renderer 按未开启发布；Host 只保留 `resolveDynamicWorkflowClientConfig` 的环境变量覆盖                                                  |
| 遥测 userId / 投放归因                          | credential store 只读                         | 可读历史键 `oauth:active_provider`、`oauth:${provider}:user_info`、`oauth:login_attribution`。解析失败返回 null，不删除键，也不构造 OAuthCredentialRepo |

## 明确留给后续

- Desktop deep link / Web `packages/web/src/auth/**` / CLI 产品 login：P3 已在 tip 落地（#33/#40/#35 等）；CodingPlanUpgrade Dialog/Provider/EntryGate/Root wrap 亦已整卸，见主计划文首状态。仍剩项（CLI TUI `loginSetup` 等）见主计划文首「仍剩」
- 凭据库中的旧 OAuth 键清理、协议字段迁移：P4
- Claude adapter 与 agent-host 核心：不改
