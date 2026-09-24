// Trusted Node-only transport observer. No request body, headers, endpoint or exception is retained.
export function createPrivateObservation(input: {
  providerId: string;
  modelId: string;
  baseUrl: string;
  api: "anthropic-messages" | "openai-chat-completions" | "openai-responses";
  maxAttempts?: number;
  allowedToolNames?: readonly string[];
  fetch: typeof globalThis.fetch;
  notify: (event: {
    kind: "model" | "http" | "dispatch";
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
  let httpDispatches = 0;
  let modelCalls = 0;
  return {
    get counts() {
      return { httpAttempts, httpDispatches, modelCalls };
    },
    onModelCall(operation: "generate" | "stream", providerId: string, modelId: string) {
      // 修复：模型身份和次数先于 executor/SDK 执行拒绝，不能依赖 HTTP 次数当作 Model 调用数。
      if (providerId !== input.providerId || modelId !== input.modelId || modelCalls >= limit)
        throw new Error("Model route/budget denied");
      input.notify({ kind: "model", operation, count: ++modelCalls });
    },
    transport: async (request: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      // 预留必须早于 await body；验证 SDK 真正序列化的请求而不是仅验证逻辑 Model id。
      const target = new URL(request instanceof Request ? request.url : String(request));
      const method = (init?.method ?? (request instanceof Request ? request.method : "GET")).toUpperCase();
      if (httpAttempts >= limit) throw new Error("HTTP budget denied before IO");
      input.notify({ kind: "http", count: ++httpAttempts });
      if (
        target.origin !== base.origin || target.pathname !== path || target.search !== "" ||
        target.username !== "" || target.password !== "" || method !== "POST" ||
        base.search !== "" || base.username !== "" || base.password !== "" ||
        init?.redirect === "follow" || (request instanceof Request && request.redirect === "follow" && !init)
      ) throw new Error("HTTP route denied before IO");
      try {
        const body = init?.body ?? (request instanceof Request ? await request.clone().text() : undefined);
        if (typeof body !== "string" || body.length > 1_048_576) throw new Error("HTTP model denied before IO");
        const serialized = JSON.parse(body);
        if (serialized?.model !== input.modelId || !Number.isSafeInteger(serialized.max_tokens) ||
            serialized.max_tokens < 1 || serialized.max_tokens > 4096)
          throw new Error("HTTP model denied before IO");
      } catch {
        throw new Error("HTTP model denied before IO");
      }
      // 修复：不修改原请求/签名/body/headers；只禁止自动重定向。成功响应须屏蔽
      // 解码错误可能含上游私有字符串（尤其 200 malformed/SSE decoder failure）。
      try {
        ++httpDispatches;
        input.notify({ kind: "dispatch", count: httpDispatches });
        const response = await input.fetch(request, { ...init, redirect: "manual" });
        if (response.ok) {
          if (!response.body) return response;
          if (!response.headers.get("content-type")?.includes("text/event-stream")) {
            const bytes = await response.arrayBuffer();
            if (bytes.byteLength > 1_048_576) throw new Error("private upstream body budget");
            let json: { content?: Array<{ type?: string; name?: string }>; error?: unknown };
            try { json = JSON.parse(Buffer.from(bytes).toString("utf8")); }
            catch { throw new Error("private upstream JSON invalid"); }
            if (json.error) throw new Error("private upstream JSON error");
            if (json.content?.some((part) => part.type === "tool_use" && !input.allowedToolNames?.includes(part.name ?? "")))
              throw new Error("private tool denied before execution");
            return new Response(bytes, { status: response.status, headers: response.headers });
          }
          const reader = response.body.getReader();
          let pending = Buffer.alloc(0);
          const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                const { done, value } = await reader.read();
                if (done) {
                  if (pending.toString("utf8").trim()) throw new Error("private upstream incomplete frame");
                  controller.close();
                } else {
                  // 修复：session tool allowlist 在 V4 create 时被 schema 丢弃；
                  // SSE tool_use 必须在 SDK 获得完整字节之前拒绝，避免任何 handler 副作用。
                  pending = Buffer.concat([pending, value]);
                  if (pending.length > 131_072) throw new Error("private upstream frame budget");
                  let released = 0;
                  for (;;) {
                    const lf = pending.indexOf("\n\n", released);
                    const crlf = pending.indexOf("\r\n\r\n", released);
                    const at = lf < 0 ? crlf : crlf < 0 ? lf : Math.min(lf, crlf);
                    if (at < 0) break;
                    const end = at + (at === crlf ? 4 : 2);
                    const event = pending.subarray(released, end).toString("utf8");
                    const data = event.split(/\r?\n/u).find((line) => line.startsWith("data: "))?.slice(6);
                    if (data) {
                      let parsed: { type?: string; content_block?: { type?: string; name?: string } };
                      try { parsed = JSON.parse(data); } catch { throw new Error("private upstream frame invalid"); }
                      if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use" &&
                          !input.allowedToolNames?.includes(parsed.content_block.name ?? ""))
                        throw new Error("private tool denied before execution");
                    }
                    released = end;
                  }
                  if (released) {
                    controller.enqueue(pending.subarray(0, released));
                    pending = Buffer.from(pending.subarray(released));
                  }
                }
              } catch {
                controller.error(new Error("private upstream stream failure"));
              }
            },
            async cancel() { try { await reader.cancel(); } catch { /* private cause */ } },
          });
          return new Response(stream, { status: response.status, headers: response.headers });
        }
        {
          // Even successful HTTP status can contain malformed/private text in SDK decoder errors;
          // adapter boundary must sanitize that exception before persistence as well.
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
        }
      } catch {
        throw new Error("private transport failure");
      }
    },
  };
}
