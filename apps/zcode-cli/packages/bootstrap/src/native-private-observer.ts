// Trusted Node-only transport observer. No request body, headers, endpoint or exception is retained.
export function createPrivateObservation(input: {
  providerId: string;
  modelId: string;
  baseUrl: string;
  api: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
  maxAttempts?: number;
  fetch: typeof globalThis.fetch;
  notify: (event: {
    kind: "model" | "http";
    count: number;
    operation?: "generate" | "stream";
  }) => void;
}) {
  const base = new URL(input.baseUrl);
  if (base.protocol !== "https:" && base.hostname !== "127.0.0.1")
    throw new Error("unapproved transport scheme");
  const prefix = base.pathname.replace(/\/+$/, "");
  const path =
    input.api === "anthropic-messages"
      ? `${prefix.toLowerCase().endsWith("/v1") ? prefix : `${prefix}/v1`}/messages`
      : input.api === "openai-responses"
        ? `${prefix}/responses`
        : `${prefix}/chat/completions`;
  const limit = input.maxAttempts ?? 12;
  let httpAttempts = 0;
  let modelCalls = 0;
  return {
    get counts() {
      return { httpAttempts, modelCalls };
    },
    onModelCall(operation: "generate" | "stream", providerId: string, modelId: string) {
      // 修复：模型身份和次数先于 executor/SDK 执行拒绝，不能依赖 HTTP 次数当作 Model 调用数。
      if (providerId !== input.providerId || modelId !== input.modelId || modelCalls >= limit)
        throw new Error("Model route/budget denied");
      input.notify({ kind: "model", operation, count: ++modelCalls });
    },
    transport: (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const target = new URL(request instanceof Request ? request.url : String(request));
      // 严格匹配唯一 SDK API 路径；不能按 host/prefix 放行另一个模型或未经批准的 endpoint。
      if (target.origin !== base.origin || target.pathname !== path || httpAttempts >= limit)
        throw new Error("HTTP route/budget denied before IO");
      input.notify({ kind: "http", count: ++httpAttempts });
      // 内建 fetch 默认跟随 30x，隐含的第二个真实 HTTP 请求既不计数也可能越过路由；
      // 私有闸门禁用自动跟随，保留请求 body/header/cache，重定向按失败处理。
      return input
        .fetch(request, { ...init, redirect: "manual" })
        .then(async (response) => {
          if (response.ok) return response;
          // 修复：上游失败正文可能回显凭据/endpoint；在私有验证中不能把它交给
          // SDK 错误包装、V4 持久化或日志。请求的 body/header 和成功响应保持原样。
          try {
            await response.body?.cancel();
          } catch {
            /* 丢弃可能携带私密原因的 cancel 错误。 */
          }
          return new Response(JSON.stringify({ error: { message: "private upstream failure" } }), {
            status: response.status,
            headers: { "content-type": "application/json" },
          });
        })
        .catch(() => {
          // 连网络错误的 cause 也可能包含原始 endpoint；禁止透传到原生持久层。
          throw new Error("private transport failure");
        });
    },
  };
}
