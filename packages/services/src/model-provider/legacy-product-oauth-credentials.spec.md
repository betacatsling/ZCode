# 产品 OAuth 凭据读者卸载

产品登录拆除后，凭据库里可能仍留着旧会话键。本切片只停止读取和使用，不擦除 `credentials.json`。

## 所有者

```text
credentials.json → ICredentialService（唯一写入者，本切片不新增写入）
新产品同步信封 → ProviderProvisioningSource.read
目标落盘 → ProviderProvisioningTarget.apply（忽略产品键）
```

遥测、反馈、Start Plan、额度重置都不再从凭据库读取产品 OAuth / JWT。它们没有第二份凭据缓存。

## 停读的键

- `oauth:active_provider`
- `oauth:zai:access_token` / `refresh_token` / `user_info`
- `oauth:bigmodel:access_token` / `refresh_token` / `user_info`
- `zcodejwttoken`
- `account-provider:*:api-key`（provisioning 新产品同步不再导出；旧信封可解析但新写入忽略）
- 同一段遥测读者里的 `oauth:login_attribution`

个人 API Key、MCP OAuth、harness 自身认证不在此列。

## 行为

- 闲时遥测 userId 为空，Authorization 为 null，渠道归因为 null。不调用 `credentialService.load`，解密失败也不登出。
- 反馈不再附带产品 JWT。列表走本地票据；没有 JWT 时本来就会走这条路径。
- Start Plan 产品 JWT 路径不可用。只返回调用方已经持有的个人 `apiKey`；没有 Key 时返回空串。
- Coding Plan 额度重置入口直接失败，不读 JWT / OAuth access token，不发重置或授权请求。团队额度查询不再读取 `oauth:*:access_token`。
- 新 provisioning 信封的 `credentials` 恒为空。不打开、不解密产品键。
- 旧信封仍能通过 schema 校验。目标应用时不 `load` / `save` / `delete` 这些产品键，因此不会把旧值擦掉。
- 个人配置与 account settings 的既有同步路径保持不变。

## 失败语义

读者返回空值或稳定的不可用错误，不把旧键的存在或损坏变成启动崩溃，也不发起新的产品授权。

## 不做

不自动擦除凭据库，不删除整个 `credentials.json`，不改 CLI、Web 产品 OAuth、MCP OAuth、Gateway/SSH 或 harness 认证。
