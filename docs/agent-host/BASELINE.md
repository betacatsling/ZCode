# 检查结果与证据归属

当前实现状态见 [ACCEPTANCE](ACCEPTANCE.md)。本文件只记录运行事实；历史全文已保存在 [归档](../archive/multi-harness/README.md)。

## 本轮实际执行

### A. 原主目录（不是整合候选）

源码：`main@438c257` **加既有未提交内容**。Node **26.8.1** / pnpm10.33.2，非固定Node24证据。

| 检查 | 结果 |
|---|---|
| workspace freshness | ahead2 / behind0，通过 |
| `pnpm typecheck` | exit0 |
| `pnpm lint` | exit0，有warnings |
| `pnpm exec tsx --test packages/services/test/agentHost*.test.ts packages/ui/test/agentHostConversationFacade.test.ts` | **27 pass / 0 fail / 0 skip** |
| `pnpm architecture:check --changed` | 0 violation / 0 baseline / 0 new |

本地日志：原工作目录 `.pi/tasks/01a0db87-0409-75a3-b66d-955fc70b8305-84446/b50143315.output`。日志是本轮本地证据，不保证别的机器存在。

### B. 整合候选

源码：`8d5d32b`（此次检查时产品源码无修改）；目录 `.worktrees/multi-harness-completion`。经 `mise exec -- node scripts/mise-run.mjs ...` 确认 Node **24.14.0**，pnpm **10.33.2**；顺序构建，Node heap上限2GiB。

| 检查 | 结果 |
|---|---|
| workspace freshness `--no-fetch` | ahead311 / behind0，通过；新分支无tracking |
| `pnpm install --offline --frozen-lockfile --ignore-scripts`（经上述wrapper） | **通过**，1992包；不等于Electron/native runtime ready |
| `pnpm --filter '@zcode/adapters...' --workspace-concurrency=1 -r build` | **失败，exit2**：`apps/zcode-cli/packages/adapters/src/model/openai-developer-role.test.ts:119` TS2351，Ajv默认导入在当前NodeNext类型下不可construct |
| `pnpm typecheck` | **通过，11项目，exit0**；不能替代未纳入同一检查面的adapters构建 |
| `pnpm lint` | **exit0，81 warnings / 0 errors**，不是无警告 |
| `pnpm architecture:check --changed` | **通过**，0 violation / 0 baseline / 0 new；不是整个309-commit历史的完整架构审计 |
| 当前候选全测试、GUI、打包、真实API、SSH生命周期、长期负载 | **本轮未执行** |

**综合结论：候选检查不是全绿。** 前置构建实际失败，不能因为后续root typecheck通过就覆盖失败。存在部分生成输出，后续干净环境重跑须自行重建，不能复用本机输出来认证远端。该错误需要独立兼顾TS类型与真实ESM行为的修复任务；历史“default/named import”互相回退的提交不能盲pick。

本地日志：原工作目录 `.pi/tasks/01a0db87-0409-75a3-b66d-955fc70b8305-84446/b6718b215.output`（安装）、`b4522fb8c.output`（检查）。后者总退出1；`prerequisites=2 typecheck=0 lint=0 architecture=0`。

### C. SSH / 资源（只读）

- `server1` 登录成功，Linux x86_64，系统Node20.19.2、Git2.25.1、user systemd为degraded。
- 资源快照：72逻辑CPU、约125.5GiB总内存/87GiB可用、约171.9GiB磁盘可用；swap约24GiB且已大量使用，不能按总内存推断没有压力。
- pi0.86.1、codex-cli0.154.0；pnpm/tmux/rsync可用，mise不在PATH。是否具备所选6Astra/6Sol/6Luna路由和认证仍需单独预检。
- 未读取/输出凭据值，未修改系统Node、现有服务或profile，未执行项目Model请求。
- 用户要求后续实际代码、构建和重测试迁server1；本机只做轻量编排/文档/审查。并发须按就绪任务、内存实测和Provider限制提升；“100倍并行”不是100个共享目录写入者。

## 历史证据（不是本轮重跑）

| 来源 | 历史记载 | 当前如何使用 |
|---|---|---|
| `1e7c0e2` BASELINE | 固定工具链27测试、typecheck、bootstrap/CLI build；临时原日志目录已不可用 | 仅历史作者报告，不移植PASS到候选 |
| `0fcdfeb` ACCEPTANCE | root11项目、52pass/8skip服务测试、若干Native/Codex joined tests | 测试入口可复用；当前结果须重跑；引用的host-usage review不在候选树 |
| `645a3f2` | 真Electron/Core/Host/Shell单会话mounted load诊断约19.4s | 不是8h、100k、多会话或匹配baseline |
| `2c249cf` / `4e26187` | 独立浏览器phone pairing/reconnect/revoke joined测试约19.4s | loopback证据；原“on this tree”缺明确执行HEAD，不能扩展成实体手机验收 |
| `8e98119` / `25f459d` | Pi×StepFun及Pi×AxonHub两个本地live loop，8/7 Model calls | 不含Native/SSH/全部模型；不是当前候选认证 |
| `fda743c` | load runner40pass/2skip | runner合同测试，不是产品负载认证 |

旧 `.tmp` 报告及清理前文档35份有 [SHA-256归档manifest](../archive/multi-harness/8d5d32b/manifest.json)。未找到的 `/tmp` 或旧review日志仍标缺失，归档不能恢复不存在的证据。

## 审计结果的质量控制

只读Agent报告由主审核对源码后采纳，不作为自动合并权。已纠正一份旧报告的两处错误：Native Registry可信注入当前已存在；model-runtime文件为“tracked文件修改一条断言”，不是新增未跟踪runtime。

一次6Sol生命周期审计在模型访问校验阶段失败（`Unable to verify Daybreak Blue access`，run `115ba294-ac96-4599-9eac-754eb167b00c`），不算完成或证据。主审直接检查 `coreAuthority.ts`、Supervisor及 `coreOwnerRecovery.ts`确认门控/恢复源码存在；完整生命周期运行仍未验证。

后续命令和执行位置见 [TASKS](TASKS.md) / [E2E](E2E.md)。真实模型额度上限100，本轮使用0。
