# CodexHost 来源与许可清单（P0）

记录时间：2026-09-28。对照计划第 12.6 节。本文记录使用方式，不是完整法律结论。分发前仍要对具体整合方式做许可审查。

## 快照

| 项 | 证据 |
|---|---|
| 仓库 | `BytePioneer-AI/codex-host` |
| 参考 commit | `d9fa7aa26474127bb80cbf086cd49503f7cc4ccf` |
| commit 时间 | `2026-09-24T08:18:18Z` |
| 标题 | `docs: redesign README screenshots as a Highlights grid` |
| 根 `package.json` | `name=codexhost`，`version=0.10.0`，`license=LGPL-3.0-only`，`packageManager=npm@11.8.0` |
| 根 `LICENSE` | GNU Lesser General Public License v3，文件头为 “GNU LESSER GENERAL PUBLIC LICENSE Version 3, 29 June 2007” |
| 本次读取方式 | GitHub API 读取 commit、根 `package.json`、`LICENSE` 开头、五个子包 `package.json`，以及该 commit 的 git tree。没有克隆工作副本，没有把文件写入本仓库 |

抽查的子包 `package.json` 没有自己的 `license` 字段：`@codexhost/harness-adapter`、`@codexhost/adapter-pi`、`@codexhost/shared-contracts`、`@codexhost/protocol-core`、`@codexhost/host-runtime`，版本都是 `0.0.0`。根声明是 `LGPL-3.0-only`。不能据此把单个文件改标成 Apache-2.0，也不能把“放到独立进程”当成免除许可义务。

ZCode 根许可是 Apache-2.0。本清单里的决策只有三类：

| 决策 | 含义 |
|---|---|
| 参考 | 读接口与架构，在 ZCode 里独立实现。不复制源码，不把上游包放进依赖 |
| 依赖 | 以包依赖或子模块链接上游产物 |
| 复制 | 把上游源码复制进本仓库，或在复制后修改 |

本次决策：计划点名的模块全部是**参考**。没有**依赖**，没有**复制**。

本仓库 `package.json` 搜索没有 `@codexhost` 或 `codex-host` 依赖。产品源码没有把 CodexHost 目录拷进来。

## 逐模块

上游 commit 均为 `d9fa7aa26474127bb80cbf086cd49503f7cc4ccf`。目标文件一列是本仓库中的对应位置；“无复制”表示没有放入该上游文件。

| 标记 | 原文件 | 本仓库目标 | 决策 | 适用许可记录 | 源码存在 | 测试存在 | 测试已运行 | 真实环境通过 |
|---|---|---|---|---|---|---|---|---|
| C1 | `packages/harness-adapter/src/text-session.ts` | 无复制。ZCode 自有契约在 `packages/shared/src/agent-host/` | 参考 | 根 LGPL-3.0-only | 是（tree 中 15727 字节，blob `a643899ad12d0c3e088aada076382eaeef3c43db`） | 是，`packages/harness-adapter/test/text-session.test.ts` | 否 | 否 |
| C2 | `packages/harness-adapter/src/plugin.ts` | 无复制 | 参考 | 同上 | 是（tree） | 同包 test 目录存在 | 否 | 否 |
| C3 | `.agents/skills/codexhost-add-harness/SKILL.md` | 无复制。该技能不作用于 ZCode | 参考 | 文档，随仓库根许可 | 是（tree） | 技能文档，不是可执行测试 | 否 | 否 |
| C4 | `packages/adapters/pi/src/pi-adapter.ts` | 无复制。ZCode Pi 代码在 `packages/services/src/agent-adapters/pi/`，独立编写 | 参考 | 根 LGPL-3.0-only | 是（tree） | 是，`packages/adapters/pi/test/` | 否 | 否 |
| C4b | `packages/adapters/pi/src/pi-rpc-session.ts` | 无复制 | 参考 | 同上 | 是（tree） | 是，`pi-rpc-session.test.ts` 在 tree 中 | 否 | 否。不能据此声明断线存活 |
| C5 | `packages/shared-contracts/src/harness-models.ts` | 无复制 | 参考 | 同上 | 是（tree） | 是，`packages/shared-contracts/test/harness-models.test.ts` | 否 | 否 |
| C6 | `packages/adapters/pi/src/pi-model-catalog.ts` | 无复制。ZCode 继续用自己的 Provider Registry | 参考 | 同上 | 是（tree） | 是，`pi-model-catalog.test.ts` | 否 | 否 |
| C7 | `packages/protocol-core/src/codex-ui-projector.ts` | 无复制。ZCode 投影走自己的 V4 projector | 参考 | 同上 | 是（tree） | 是，`codex-ui-projector.test.ts` 等 | 否 | 否 |
| C8 | `docs/architecture/harness-plugin-runtime.md` | 无复制 | 参考 | 文档 | 是。contents API：22355 字节，blob `9a73cf28e3381e4af8d35c8ef42b5a211303010f`。本次未逐段阅读正文 | 文档 | 否 | 否 |
| C9 | `packages/adapters/claude-code/src/sdk-transport.ts` | 无复制 | 参考 | 根 LGPL-3.0-only | 是（tree） | 是，`sdk-transport.test.ts` | 否 | 否 |
| C9b | `packages/adapters/claude-code/src/plugin.ts` | 无复制 | 参考 | 同上 | 是（tree） | 同包 test 目录存在 | 否 | 否。Broker 选择不是持久化证明 |
| C10 | `.agents/skills/codexhost-add-harness/references/thread-lifecycle-and-history.md` | 无复制 | 参考 | 文档 | 是（tree） | 文档 | 否 | 否 |
| C11 | `packages/harness-adapter/test/text-session.test.ts` | 无复制 | 参考 | 测试源码，随根许可 | 是（tree） | 它本身是测试 | 否 | 否。Fake 通过也不能代替原生或 SSH |
| C12 | 根 `package.json` | 无复制 | 参考 | 文件内写明 `LGPL-3.0-only` | 是，本次已读内容 | 不适用 | 不适用 | 不适用 |
| C14 | 根 `LICENSE` | 无复制 | 参考 | LGPL v3 文本 | 是，本次已读文件头 | 不适用 | 不适用 | 不适用 |
| H4 | `packages/adapters/pi/manifest.json` | 无复制。不能把其中的图标路径直接交给浏览器 | 参考 | 根 LGPL-3.0-only | 是（tree） | 不适用 | 否 | 否 |

保留声明：没有复制，所以没有在 ZCode 源文件中保留 CodexHost 版权头。若以后复制，必须保留上游声明，并单独记录目标文件。

分发方式：当前不分发 CodexHost 源码或构建产物。

待确认义务：在任何复制或依赖之前，确认该文件的版权人、是否含有额外非 LGPL 素材、对应源代码提供方式，以及与 Apache-2.0 仓库一起分发时的组合义务。独立进程不能自动免除这些义务。

## 只做导航、未逐行审计的目录

GitHub tree 确认这些顶层包在同一 commit 存在。计划写明当时没有全面审计 `mapping-store`、`harness-broker`、`host-runtime`。本次同样只确认路径存在，决策仍是参考，未依赖，未复制，测试未运行，真实环境未通过。

| 上游目录 | 决策 | 说明 |
|---|---|---|
| `packages/mapping-store/` | 参考 | 含 `src/mapping-store.ts` 与 test |
| `packages/harness-broker/` | 参考 | 含 client/server/protocol 与 test |
| `packages/host-runtime/` | 参考 | 含插件加载、远端生命周期、官方 app-server。体积大，未逐文件阅读 |
| `packages/harness-discovery/` | 参考 | 未逐行阅读 |
| `packages/desktop-control/` | 参考 | Codex Desktop 注入与控制。计划明确不复制 |
| `packages/renderer-extension/` | 参考 | Codex UI 接线。计划明确不复制 |
| `packages/protocol-core/` 其余文件 | 参考 | 除 C7 外未逐行阅读 |
| `packages/update-manager/`、`packages/repository-automation/` | 参考 | 与本次 Harness 契约无对应复制 |
| `packages/adapters/` 下其余适配器 | 参考 | tree 中可见 antigravity、claude-code、codebuddy、cursor-cli、deepseek-harness、grok、hermes、kimi-code、kiro-cli、omp、opencode、pi、qoder、workbuddy 等。均未复制 |

## PR #337

| 项 | 本次查询 |
|---|---|
| PR | `BytePioneer-AI/codex-host` #337 |
| 状态 | `OPEN`，`isDraft=true`，`mergedAt=null`，`closedAt=null` |
| 分支 | `draft/zcode-integration` |
| head | `b66013bbcc6a8d5292f671957528680b13be57f8` |
| 标题 | `feat: preserve ZCode integration for future redesign` |
| 正文 | 开头写明“归档保留，不可合并”。它保存的是把 ZCode 接进 CodexHost 的旧实现，验证记录指向 ZCode 3.12.3 |

决策：参考已写明的失败场景（手工配对、单工作区、换目录要改配置并重启、真实账号与 CAPTCHA 未验收）。不依赖，不复制，不把它当成 ZCode 桌面认证或配对代理的实现。ZCode 原生路径继续使用本仓库的 runtime。该 PR 的测试通过记录是上游正文里的陈述，本次没有复跑。
