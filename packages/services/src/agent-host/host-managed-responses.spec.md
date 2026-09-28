# Host-managed Responses 调用栈

计划第 12 节：`host-managed` 必须经过现有模型执行层。本文件不新增第二套模型客户端，也不保存 Provider Key。

## 所有者

```text
ModelBindingPlanner.plan
  → 线协议 BindingPlan
  → Harness.prepareModel / bindHostModel
  → AiSdkModelAdapter.createModel
  → Model Gateway POST /v1/responses
  → Model.streamText
  → 127.0.0.1 上的 fixture Provider
```

- 路由是否成立只由 `ModelBindingPlanner` 决定。
- 模型执行只由 `@zcode/adapters/model` 的 `AiSdkModelAdapter` 决定。
- `/v1/responses` 的准入、grant 和编码只由 Model Gateway 决定。
- fixture Provider 只回答假文本。Key 使用 `fixture-only` 这类测试字面量，URL 只允许 loopback。

## 行为

`ModelBindingPlanner` 给出 `support = supported` 且执行种类是 `existing-model-runtime` 时，Gateway Responses（`openai-responses`）准入三条生产路由：`responses-gateway`（Codex）、`pi-sdk`（`PiHarnessAdapter`）、`messages-gateway`（Claude Code）。三条都要求推理级别是 `none`、`off` 或 `disabled`，并且已经绑定的 Model 身份与计划一致。满足时，调用栈按上面的顺序打到 Gateway 和 `Model.streamText`。

`anthropic-messages` 仍然只准入 `messages-gateway`。`native`、`mock`、`harness-managed` 不能进入 Responses。

下面这些组合打不到执行层，保持 `experimental`，不能用跳过执行层的假 Model 标成完成：

- Claude Code 默认 mock 端口、ACP 传输，以及只注入 `kind: "model-execution-layer"` 证据、没有 `modelFactory` 的端口。
- Pi 控制面 `PiAdapter`。它的路由字面量也是 `pi-sdk`，但不调用 `prepareModel`。
- `packages/services/src/agent-adapters/claude` 的 Messages 授权。它走 `anthropic-messages`，本切片不把它当成 Responses 已接通。
- ACP harness、推理级别不是关闭、或规划结果不是 `supported`。

`capabilities.hostManagedModel` 仍描述控制面有没有观察到轨迹。Responses 集成打通模型栈，不等于 app-server、ACP 或 live Provider 已认证。

## 失败

- 规划拒绝：返回 `experimental` 和规划原因，不发 Provider 请求。
- Gateway 或执行层抛错：测试失败，不改写成通过。
- 不启动 SSH daemon，不关闭 Electron，不访问真实 Provider。
