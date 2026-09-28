# Mac 实机恢复

只在有图形会话的 Mac 上做。不测 Linux SSH、Windows、WSL，也不要改这些平台的实现。远程附着仍沿用仓库里已有的路径；这次不要连 Linux 远端，不要新造 daemon，不要使用 mosh 或 autossh。

基线是合成分支 PR #15。本机常驻进程只用现有 `server-cli serve --daemon`。在 darwin 上且没有把 `ZCODE_SERVER_SKIP_SERVICE_REGISTRATION` 设为 `1` 时，这条命令注册并拉起 launchd。窗口关闭和退出整个 Electron 都只断开附着，不停止 Core。

不要把凭据、主机名、token、prompt 正文写进仓库、提交或下面的结果模板。

## 准备

1. 确认 `uname` 是 Darwin，并且当前用户有图形会话。没有 Mac 桌面就不要做，结果写 skipped。
2. 用本机数据目录里的状态文件看 Core，不要靠 SSH。状态在数据根下的 `.zcode/server/run/status.json`。数据根默认是用户主目录；若设置了 `ZCODE_DATA_BASE_DIR`，用那个目录。评论里把监听地址写成「loopback」，不要贴原始地址。
3. launchd 标签形如 `com.zhipu.zcode.server.<路径摘要>`，plist 在同一 server 根的 `service/` 下。可以用 `launchctl print gui/<uid>/<标签>` 看 job 是否还在。不要把 plist 或本机路径贴进评论。
4. 桌面日志在数据根下的 `.zcode/v2/logs/`，按日期一个文件。失败时只给出脱敏后的文件路径。

记下测前的 `state`、`pid`、`generation`、`serviceRegistered`、`runningTaskCount`。`serviceRegistered` 不是 true 时，说明没有走 launchd，先去掉跳过服务注册的环境变量再测。不要把这次结果记成通过。

## 窗口关闭后 Core 仍在

1. Core 已是 `ready`，`serviceRegistered` 为 true，`host` 是 loopback。
2. 只关闭窗口，不退出应用，不执行 stop。
3. 再读 `status.json`，并再看一次 launchd job。

通过：`state` 仍是 `ready`，`pid` 与 `generation` 不变，`serviceRegistered` 仍为 true，launchd job 仍在。`runningTaskCount` 不因为关窗口被清掉。

失败：`state` 变成 `stopped`、`crashed` 或其他非 `ready`；`pid` 为空或变了；launchd job 消失；Core 进程退出。

## Electron 全退后任务继续且不重发 prompt

1. 先让一条任务被接受。只记下 `commandId`，不要复制 prompt。
2. 确认任务仍在进行（`runningTaskCount` 大于 0，或该会话仍是 busy）。
3. 退出整个 Electron（Quit），不是只关窗口。
4. 再读 Core 状态，确认任务没有被标成完成或停止。
5. 重新打开应用并接上同一个 Core。看同一 `commandId` 是否被再次接受。

通过：退出后 Core 仍 `ready`，`pid` 不变，launchd 仍在；该任务继续，没有因为退出被标成 succeeded、completed 或 stopped。重连后还是原来的 `commandId`，没有新的 send 被接受，对话里没有第二条相同 prompt。

失败：退出把 Core 停掉，或把任务标成完成/停止。重连又接受了同一条 prompt，或出现新的 `commandId`。只做到「没有重发」、但任务已经停了，整项仍是失败。

## 审批中断线仍是同一请求

1. 停在一个待决审批上。只记下 `interactionId`。
2. 关掉应用再打开，或断开后重连。不要在重连过程中点允许或拒绝。
3. 看待决列表里的 `interactionId`。

通过：仍是原来的 `interactionId`，状态还是待决。重连没有新建审批，也没有代替用户允许或拒绝。

失败：审批消失、被解决，或换成了另一个 `interactionId`。

## 反馈

不要在仓库里写凭据、主机名、token。把结果按下面模板贴到 PR 评论，或交给项目协调者。每项用 pass、fail 或 skipped，并加一句现象。失败时附脱敏日志路径（`.zcode/v2/logs/` 下的日期文件，以及 `.zcode/server/run/status.json`），不要贴密钥。

```
Mac 版本：
Zcode 提交：
- 窗口关闭后 Core 仍在：
- Electron 全退后任务继续且不重发 prompt：
- 审批中断线仍是同一请求：
备注：
```
