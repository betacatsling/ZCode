# P3 预备：CLI/TUI 产品登录删除清单（Ex1）

基线：`/workspace/ZCode-ex1-nologin-p3-cli` @ `685f68d`。  
对照计划 §3 表 + §P3。分类：**必删** / **保留** / **待核实**。

## 目标摘要（§P3）

- 删 CLI 产品 login/logout 与 TUI 登录门禁；旧 `/login` API Key → 既有 Provider 配置（新命令须先有契约）。
- 旧 login 返回明确「已移除，请配置模型」，不打开浏览器、不写 token。
- **保留**：MCP OAuth、login-shell、harness 自身认证。

## 总表（分类）

| 分类 | 路径 | 角色 | 依据 / 备注 |
|---|---|---|---|
| **必删** | `cli/src/login-command.ts` | `runLoginCommand` / `runLogoutCommand` → 产品 OAuth | §3 CLI 行；§P3 删 login/logout |
| **必删** | `cli/src/tui-auth.ts` | TUI 调 `loginZCodeCli` / bigmodel login | 产品登录实现，无 MCP |
| **必删** | `cli/src/command-center/login-flow.ts` 中 **OAuth 选项** | `/login zai-coding-plan`、`bigmodel-coding-plan` | §P3 删产品 OAuth 入口 |
| **必删** | `bootstrap/src/auth-login.ts` | `loginZCodeCli` 浏览器 OAuth + 写凭证 | §3；依赖 P2 拆服务后无调用方 |
| **必删** | `bootstrap/src/auth-login-polling.ts` | 仅被 auth-login 使用 | 随 auth-login |
| **必删** | `bootstrap/src/auth-login-abort.ts` | 仅 auth-login / polling 引用 | 随上二者删 |
| **必删** | `bootstrap/src/index.ts` 的 `auth-login` 导出 | 对外导出产品 login | 去掉 export |
| **必删**（逻辑） | `cli/src/run.ts` login/logout 分支 | 子命令挂载 | 断入口；文件本身保留 |
| **必删**（逻辑） | `cli/src/prompt-command.ts` 产品 `/login`/`/logout` | 斜杠命令 | 断入口 |
| **必删**（逻辑） | `cli/src/command-center/create.ts` 登录门禁 + OAuth login-flow 装配 | `loginRequiredResponse`、OAuth usage | 去掉门禁；文件保留改 |
| **必删**（文案） | i18n `en-US`/`zh-CN` 中 loginRequired、`/login` 产品说明 | 逼登录文案 | §P5 清字符串；改→配置 Provider |
| **待核实** | `login-flow.ts` 中 **API Key 选项**（`*-coding-plan-api-key`） | 现挂在 `/login` 下 | §P3：导向 Provider 配置；**迁走后删挂点**，勿无文档承诺尚无命令 |
| **待核实** | `cli/src/tui-login-state.ts` | `loginRequiredResponse` + `createTuiModelAvailabilityChecker` | 前者**必删**用法；checker 可能**保留**（只看模型可用性）——拆函数后再定文件 |
| **待核实** | `cli/src/tui-prompt-handler.ts` | 引用 tui-auth / availability | 改接线，非整文件删 |
| **待核实** | `cli/src/cli-types.ts` 的 `loginZCodeCli` 注入类型 | 测试/DI | 随 login 删除 |
| **待核实** | `adapters/src/auth/cli-oauth.ts`、`bigmodel-oauth.ts`、`localhost-callback.ts`、`coding-plan-api-key.ts` | CLI 产品 OAuth/API Key 适配 | 若仅产品 login 使用 → 可随 P2/P3 删；先确认无其它消费者 |
| **待核实** | `adapters/src/auth/shared-credentials.ts`、`credential-cipher.ts` | 共享凭证 | §P2/P4：禁止整库删除；只停产品账号读写 |
| **保留** | `adapters/src/mcp/oauth*.ts` | 第三方 MCP OAuth | §3 明确非删除目标；验收矩阵 MCP 行 |
| **保留** | login-shell / harness 原生认证相关 | 非产品账号 | §3「不是本次删除目标」 |
| **保留** | 个人 Provider 配置、通用 credential service | 自配模型 | §P2 保留能力 |
| **保留** | Desktop/Web UI、`packages/services/src/oauth/**` | 他轨 | Ex4 P3-web；ex6 P2 |
| **改造非盲删** | 旧 `zcode login` 调用点 | 移除反馈 | §P3：明确错误，不假成功、不打开浏览器 |

## 建议顺序

1. 断 `run.ts` / `prompt-command` 产品 login/logout → 旧命令返回「已移除」。  
2. 拆 TUI 门禁与 login-flow OAuth；API Key **待核实**迁 Provider。  
3. 删 `tui-auth` + bootstrap `auth-login*`（确认引用）。  
4. 收 i18n；补 CLI 无登录入口测。  
5. 与 **P2**（#20 后拆 `node.ts` oauth）对齐后再动 shared credential 产品路径。

## 对 @ex6

依赖 #20 / P2 再动的项：`auth-login` 所写账号/Coding Plan 凭证、`adapters/auth/*` 待核实行、shared credential 产品键——勿在 P1 UI 合入前删服务注册。

## 本波已落地（Ex1，分支 `ex1/nologin-p3-cli-inventory`）

- `login-command.ts`：login/logout → 明确 removed，exit 1，不调 OAuth/浏览器
- `command-center/create.ts`：产品 OAuth `/login`/`/logout` → removed；API Key 挂点暂留（待核实）
- `tui-auth.ts`：login/logout 抛 removed；`configureApiKeyForTui` 暂留
- `tui-login-state.ts`：无模型时文案指向配置 Provider
- **未删** bootstrap `auth-login*`（等 P2）

## 依赖刷新（#20 → `96f018a`）

- P1/#20 前置已解除；**仍不抢** P2 `node.ts`/oauth 装配（ex6）。
- Ex1 入口断点 + gate 验证见 `/workspace/ex1-cli-gate-verify.md`。
- bootstrap `auth-login*` / 产品 oauth 适配器：等 P2 拆完同批或 P3 卸调用方。

## P3 实现（#27 合入后）

所有者：bootstrap 不再提供产品浏览器 OAuth。`/login` API Key 的写入所有者仍是 `configureCodingPlanApiKey`，由 `configureApiKeyForTui` 调用。

- 删除 `bootstrap/src/auth-login.ts`、`auth-login-polling.ts`、`auth-login-abort.ts`，以及 `index.ts` 的 `export * from "./auth-login.js"`。
- `loginZCodeCli` / `loginBigmodelCodingPlan` / `logoutZCodeCli` 与 `cli-types.ts` 上对应 DI 钩子一并删除。入口 stub（#21）不回滚。
- API Key 持久化抽到 `bootstrap/src/coding-plan-api-key-config.ts`。空 key 仍抛 `ZCodeCliLoginError`（`config_update_failed`）。
- `adapters/src/auth/cli-oauth.ts`、`bigmodel-oauth.ts` 仅被已删的 auth-login 引用，已删。MCP 不引用它们。
- 保留：`localhost-callback.ts`、`shared-credentials.ts`、`coding-plan-api-key.ts`（token 换 key 的 resolver，登录删除后暂无调用方）、MCP oauth、`configureApiKeyForTui`。不改 `packages/services` oauth / `node.ts`。
