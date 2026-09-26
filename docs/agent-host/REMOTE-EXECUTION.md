# server1 执行策略：代码在远端，主机只编排

## 用户决定与资源边界

用户要求实际代码、安装、构建、重测试迁到SSH目标 `server1`，任务尽量细并扩大并行。当前先完成成果整合与gap文档，不据此跳过依赖直接启动全部功能实现。

只读快照：72逻辑CPU，约125.5GiB总内存、87GiB可用，磁盘约171.9GiB空闲，swap已有大量占用。系统Node20.19.2不符合项目固定24.14.0；pi0.86.1、codex-cli0.154.0与本机版本不同。

`pi --list-models gpt-6` 在远端能枚举 `openai-codex/gpt-6-astra`、`gpt-6-sol`、`gpt-6-luna`。它们用于**开发 subagent**，不是 M-01/M-04/M-05 的项目测试模型；后者按用户明确答复使用 **StepFun 全部模型与 AxonHub DeepSeek**，两组不得互换。**目录存在不是认证/配额/可调用证明**。启用前做小规模受限预检；不复制本机凭据。后续不自动升级系统工具或更改默认profile。

## 先迁移可审计源码，再启动写入

1. 准备候选源码快照及文件SHA-256清单，记录原commit和文档整理diff。仅传输明确列出的项目文件；排除个人 `.pi`、HOME、密钥、`.env`运行配置、node_modules、dist和外部symlink。
2. 在server1新建本任务专用目录；不覆盖任何现有项目或服务。目标解包先校验路径和manifest。运行配置/凭据由目标自己的明确授权入口提供。
3. 使用独立固定Node24.14.0/pnpm10.33.2；不能让系统Node20运行项目检查。依赖及Linux native产物在目标内安装/构建，不传Mac二进制。
4. 建立只读基线、每个写入任务独立worktree和单一integration worktree。记录来源commit、任务ID、worker模型、输入/输出hash、验证与patch；结果按依赖由一个集成人合并。
5. 回传小体积diff和脱敏证据，不回传credentials或全量runtime输出。主机当前main未提交改动保持原样。

这是执行合同，不是已部署成功声明；实际远端路径/清单校验/Agent预检结果应另记录到BASELINE。

## 并行不是100个共享目录写入者

[TASKS](TASKS.md) 已拆54个工作包，并不是54个都可同时运行：Catalog公共合同、Core/Host所有者、Native安全验证器存在串行依赖。

- 先用少量只读与独立写入任务实测峰值RSS、工具时间和Provider限流，再逐步提高并发。
- 可为read-only分析、实现、编译/测试设置不同队列；重构建同时运行数远小于分析Agent数。有效并发=min(就绪独立任务、资源余量、Provider配额)。
- 扩到数十甚至100个并行任务前，必须有相应独立工作包和实测资源余量；不人为制造重复审计或让等待依赖的Agent空转。
- 单个父任务失败保留其目录、diff和日志，不自动创建第二个owner。共享协议先冻结，Agent不能各自发明一份接口。
- 大事件/纯Node/Linux验证在server1；真正Mac/Electron窗口证据保留单独平台窗口，不能把Linux无头输出写成Mac通过。
- 真实项目模型调用统一额度100次（包含辅助与重试），与开发Agent调用分开。并行worker不能各自领取100次。

## 首个远端代码任务

优先V-04：修复本轮已经实测的 `openai-developer-role.test.ts:119` Ajv TS2351，必须同时验证NodeNext编译与真实ESM测试。随后I-02可复核那条尚未整合的拒绝断言；I-04的四个安全提交必须作为一个有界联动实现，不能分给四个Agent盲目cherry-pick。

发布、默认启用Native/Codex/Claude、覆盖现有服务和长期压力运行不属于源码搬运或并行许可的隐含副作用。
