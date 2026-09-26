# E2E 入口与证据等级

当前源码 `8d5d32b` 已不止 Button smoke。此文保留有效隔离/验收规则，当前运行结果集中在 [BASELINE](BASELINE.md)，剩余任务见 [TASKS](TASKS.md)。不再将“最早fixture没覆盖”描述为“整个项目没有产品测试”。

## 已存在的入口

| 层级 | 源码入口 | 可以证明 / 不能据此证明 |
|---|---|---|
| 基础浏览器 smoke | `packages/ui/e2e/foundation.spec.ts` | Button、输入、焦点、截图；不是产品 composer/Host |
| 三层组件/资产 | `hierarchy.spec.ts`、`harness-assets.spec.ts`（同目录） | 真实组件、双Harness身份、隐藏attention、fallback；回调fixture不是Git安全执行 |
| 已挂载UI | `mounted-hierarchy.spec.ts`、`session-mounted.spec.ts`、`session-mounted-uncertain.spec.ts`、`shell-pane.spec.ts` | service-backed UI、owner路由、draft与uncertain门控；控制数据不等于真实Provider |
| Electron/Core joined | `packages/desktop/e2e/actualShellMount.spec.ts`、`actualShellReadonlyJoin.spec.ts` | 真Core→utility Host→preload→Shell、原生/外部owner与只读归档；运行结果须单独记录 |
| 单会话负载诊断 | `packages/desktop/e2e/loadProductMount.spec.ts` | 产品挂载、浏览器paint、owner journal、pid/RSS诊断；不是8h/100k/50/10/5或可比baseline |
| 独立浏览器配对 | `packages/desktop/e2e/pairedPhoneActual.spec.ts` | 桌面consent、独立浏览器、同Host replayable attach/reconnect/revoke；仅loopback，不是实体手机/TLS |

## 执行方式

仓库根目录，固定Node24.14.0/pnpm10.33.2：

```sh
p() { mise exec -- node scripts/mise-run.mjs pnpm "$@"; }
p e2e:ui
# 可单独运行一个组件文件
p exec playwright test -c scripts/e2e/multi-harness/playwright.config.ts hierarchy.spec.ts
# Electron按对应config运行，先准备当前候选的Main/Host/preload/renderer及runtime资源
p exec playwright test -c packages/desktop/e2e/actualShellReadonlyJoin.config.ts
p exec playwright test -c packages/desktop/e2e/pairedPhoneActual.config.ts
```

server1没有mise时先提供隔离固定Node/pnpm，不能直接使用系统Node20。Electron/macOS专属证据仍需相应平台，不从Linux模拟推断。

- UI fixture由Playwright启动loopback Vite；desktop Chromium与mobile viewport分别执行。
- `ZCODE_E2E_ARTIFACT_DIR` 指定专用父目录，runner创建唯一run目录，不清空其他数据；`ZCODE_E2E_CHROMIUM_PATH` 仅显式选择browser。
- Electron可用 `ZCODE_TEST_ELECTRON_EXECUTABLE`，phone可用 `ZCODE_TEST_PHONE_BROWSER`；缺二进制/当前构建资产要记录环境阻塞。
- `ZCODE_MOUNTED_HISTORY_E2E=1` / `ZCODE_HISTORY_LIFECYCLE_E2E=1` 是独立opt-in；不因普通suite通过就声称它们执行过。
- script-free install、Vite build、生成bundle都不能单独算安装包运行通过。

## 所有者、隔离与事件顺序

组件从 `@zcode/ui` 公开入口挂载，服务注入经 `ServiceProvider` / `PlatformProvider` 与 `IServiceAccessor` / `IPlatformService`。测试root的控制面不替换生产全局服务，不修改个人账号，不把React本地state当Host真相。

```text
浏览器动作 → 服务hook/facade → Core/Host/CLI唯一owner → 已确认事件 → UI
重连 → 读取原command receipt / snapshot / cursor → 恢复视图（不重新send）
```

每个fixture拥有独立HOME/data/browser profile、Git目录和子进程；退出必须回收真实子进程再清理自己的目录。超时只能表示失败，不能伪装reap、同步完成或零副作用。

## 尚需封板的产品场景

- 同实际worktree两个Pi加一个Native：不增worktree，模型/上下文/取消/draft独立；关闭视图只detach。
- 后台输出、discover、SSH重连与恢复期间用户编辑：focus、光标、草稿、selected owner不被覆盖。
- 隐藏/折叠workspace仍有审批入口；offline不显示成功；不同target同path不串历史。
- 真实target删除与新建准入竞态、目录重建、旧子目录cwd和非Git兼容；不能只断言fixture callback。
- 待审批、断档、撤销配对和GUI退出时，两种delivery语义分别检查；loopback与物理远控分开报告。
- 真Provider、SSH持续运行、安装包、长期性能分别验收。Fake与组件用例不关闭这些gate。
