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

生产 `hostManagedRoute` 必须已经是 `responses-gateway`，并且 `hostManagedSupport` 为 `supported`，规划结果的执行种类必须是 `existing-model-runtime`。满足时，调用栈按上面的顺序打到 Gateway 和执行层。

生产路由不是 `responses-gateway`，或宿主支持度不是 `supported` 时，不调用 `Model.streamText`，该组合保持 `experimental`。不能用跳过执行层的假 Model 把这种组合标成完成。

`capabilities.hostManagedModel` 仍描述控制面有没有观察到轨迹。Responses 集成打通模型栈，不等于 app-server、ACP 或 live Provider 已认证。

## 失败

- 规划拒绝：返回 `experimental` 和规划原因，不发 Provider 请求。
- Gateway 或执行层抛错：测试失败，不改写成通过。
- 不启动 SSH daemon，不关闭 Electron，不访问真实 Provider。
