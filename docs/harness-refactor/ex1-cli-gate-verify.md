# Ex1 · CLI/TUI 产品登录入口验证（#20 已合后）

**Worktree:** `/workspace/ZCode-ex1-nologin-p3-cli`（分支 `ex1/nologin-p3-cli-inventory`，入口断点未 commit）  
**Gate 脚本:** `/workspace/ex1-cli-gate/verify-product-login-removed.mjs`  
**日志:** `/tmp/ex1-cli-gate-verify.log`（`ok: true`）  
**#20:** 已合入 wave4（`96f018a`）→ 清单依赖从「等 #20」改为「跟 P2 拆装配；Ex1 不抢 `node.ts`/oauth」。

## 验证结论

| 检查 | 结果 |
|---|---|
| `login-command.ts` 静态：无 browser/oauth/`loginZCodeCli`/`spawn` | pass |
| `tui-auth.ts`：`loginForTui`/`logoutForTui` 抛 `PRODUCT_LOGIN_REMOVED_MESSAGE`；不调 bootstrap OAuth | pass |
| `create.ts`：产品 `/login`/`/logout` 返回 removed 文案 | pass |
| 行为契约（镜像 stub）：text/json 均 exit **1**，文案含 removed，json `code=product-login-removed` | pass |
| 是否打开浏览器 / 写 token | **否**（stub 无副作用路径；bootstrap `auth-login*` 仍在树内但入口不再调用） |

复跑：

```bash
node /workspace/ex1-cli-gate/verify-product-login-removed.mjs
```

## 「待核实」逐条建议（#20 已合）

| 项 | 建议 | 一句理由 |
|---|---|---|
| `login-flow.ts` API Key 选项（`*-coding-plan-api-key`） | **留挂点 → 并入 P3 迁 Provider** | §P3 要求迁到既有 Provider 配置后再删 `/login` 挂点；现入口 OAuth 已断，Key 路径可暂留避免无替代命令 |
| `tui-login-state.ts` | **拆：`loginRequiredResponse` 文案已改 → P3 可删逼登；checker 保留** | 模型可用性检查非产品账号；门禁文案已指向配置 Provider |
| `tui-prompt-handler.ts` | **改接线（P3），非整文件删** | 只换 auth/availability 引用 |
| `cli-types.ts` 的 `loginZCodeCli` 等注入 | **并入 P3**（随 stub 清 DI 类型） | 入口已不用；删类型可等 bootstrap 卸导出同批，避免半截编译 |
| `adapters/auth/cli-oauth.ts`、`bigmodel-oauth.ts` | **并入 P2/P3 同批删**（ex6 主导） | 主要为产品 login；确认无其它消费者后删；Ex1 不抢 |
| `adapters/auth/localhost-callback.ts` | **保留（MCP 共用）** | `mcp/oauth-interactive` 引用；勿当产品 login 盲删 |
| `adapters/auth/coding-plan-api-key.ts` | **待 P3 与 Provider 配置对齐后再定** | CLI login-flow + provider 配置均有引用；非纯产品 OAuth |
| `adapters/auth/shared-credentials.ts`、`credential-cipher.ts` | **保留能力；P2 只停产品账号键** | MCP OAuth 大量依赖 SharedZCodeCredentialStore；禁止整库删 |
| bootstrap `auth-login*` | **并入 P2 后由 ex6/同批卸**（Ex1 已断调用） | #20 已合，可拆服务；Ex1 不删实现文件 |

## 本波不做

- 不 commit / 不 push  
- 不改 `/workspace/ZCode` Claude 脏树  
- 不碰 P2 `node.ts` / `packages/services` oauth 装配  

## 一行结论（给 Planner）

CLI gate 绿：login/logout 返回 removed 且无浏览器；待核实建议已写入本文件；等 P2 服务拆完再卸 bootstrap/`cli-oauth`。
