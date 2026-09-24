import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type {
  ModelGateway,
  ModelGatewayOptions,
  GatewaySseFrame,
  GatewayTokenBinding,
} from "./contract.js";
import {
  authorize,
  GatewayError,
  newToken,
  validateBinding,
  validateProtocols,
  type TokenState,
} from "./routeAuthorization.js";

function safeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (
    error instanceof Error &&
    "statusCode" in error &&
    (error.statusCode === 400 || error.statusCode === 422) &&
    "code" in error &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,48}$/.test(error.code)
  ) {
    return new GatewayError(error.statusCode, error.code);
  }
  return new GatewayError(500, "gateway_failed");
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const contentLength = req.headers["content-length"];
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > maxBytes))
    throw new GatewayError(413, "body_too_large");
  if (req.headers["content-encoding"] && req.headers["content-encoding"] !== "identity")
    throw new GatewayError(415, "unsupported_encoding");
  const chunks: Buffer[] = [];
  let bytes = 0;
  const reader = req[Symbol.asyncIterator]();
  for (;;) {
    const { done, value: chunk } = await reader.next();
    if (done) break;
    bytes += chunk.length;
    if (bytes > maxBytes) {
      req.pause();
      throw new GatewayError(413, "body_too_large");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new GatewayError(400, "invalid_json");
  }
}
function serialize(frame: GatewaySseFrame, maxBytes: number): Buffer {
  if (frame.event !== undefined && !/^[a-zA-Z0-9_.-]{1,64}$/.test(frame.event))
    throw new GatewayError(500, "invalid_sse_event");
  let visited = 0;
  const json = JSON.stringify(frame.data, (_key, value: unknown) => {
    if (++visited > maxBytes || (typeof value === "string" && Buffer.byteLength(value) > maxBytes))
      throw new GatewayError(429, "output_budget_exceeded");
    return value;
  });
  if (json === undefined || Buffer.byteLength(json) > maxBytes)
    throw new GatewayError(429, "output_budget_exceeded");
  return Buffer.from(`${frame.event ? `event: ${frame.event}\n` : ""}data: ${json}\n\n`);
}
async function waitForDrain(res: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || res.destroyed) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      res.off("drain", done);
      res.off("close", done);
      signal.removeEventListener("abort", done);
      resolve();
    };
    res.once("drain", done);
    res.once("close", done);
    signal.addEventListener("abort", done, { once: true });
  });
}
function sendError(res: ServerResponse, error: GatewayError): void {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.end(serialize({ event: "error", data: { error: { code: error.code } } }, 512));
    return;
  }
  res.writeHead(error.statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    connection: "close",
  });
  res.end(JSON.stringify({ error: { code: error.code } }));
}

/** Target-local injected transport. Caller owns session/epoch admission; this server owns only its live tokens. */
export function createModelGateway(options: ModelGatewayOptions): ModelGateway {
  const { resolveModel, limits, observe } = options;
  if (
    !Number.isSafeInteger(limits.maxBodyBytes) ||
    limits.maxBodyBytes <= 0 ||
    !Number.isSafeInteger(limits.maxConcurrentRequests) ||
    limits.maxConcurrentRequests <= 0
  )
    throw new GatewayError(400, "invalid_limits");
  const routes = validateProtocols(options.protocols);
  const tokens = new Map<string, TokenState>();
  let active = 0;
  let closing = false;
  let address: { url: string; port: number } | undefined;
  let starting: Promise<{ url: string; port: number }> | undefined;
  let stopping: Promise<void> | undefined;
  function revoke(token: string): void {
    const state = tokens.get(token);
    if (!state) return;
    tokens.delete(token);
    clearTimeout(state.timer);
    for (const controller of state.active) controller.abort();
  }
  const server = createServer(async (req, res) => {
    let controller: AbortController | undefined;
    let state: TokenState | undefined;
    const disconnected = () => controller?.abort();
    const cancelled = () => {
      if (!res.destroyed) res.destroy();
    };
    res.on("close", disconnected);
    req.on("aborted", disconnected);
    try {
      if (closing) throw new GatewayError(503, "gateway_closed");
      // Do not accept path normalization, query credentials, alternate URLs, cookies or ambiguous proxy hosts.
      if (
        !address ||
        req.headers.host !== `127.0.0.1:${address.port}` ||
        req.headers.cookie ||
        req.url?.includes("?") ||
        req.url?.includes("#") ||
        req.headers["x-upstream-url"]
      )
        throw new GatewayError(400, "invalid_transport");
      const protocol = routes.get(req.url ?? "");
      if (!protocol) throw new GatewayError(404, "unsupported_endpoint");
      if (req.method !== "POST") throw new GatewayError(405, "unsupported_method");
      state = authorize(req, tokens, protocol.id);
      if (active >= limits.maxConcurrentRequests)
        throw new GatewayError(429, "concurrency_exceeded");
      active++;
      controller = new AbortController();
      controller.signal.addEventListener("abort", cancelled, { once: true });
      state.active.add(controller);
      const body = await readJson(req, limits.maxBodyBytes);
      if (controller.signal.aborted || state.binding.expiresAt <= Date.now())
        throw new GatewayError(401, "unauthorized");
      const decoded = protocol.decode(
        body,
        Object.fromEntries(
          Object.entries(req.headers).map(([key, value]) => [
            key,
            typeof value === "string" ? value : undefined,
          ]),
        ),
      );
      if (decoded.stream !== true || decoded.modelId !== state.binding.requestedModelAlias)
        throw new GatewayError(422, "model_or_stream_mismatch");
      state.requests++;
      const model = await resolveModel(state.binding);
      if (controller.signal.aborted) throw new GatewayError(401, "unauthorized");
      if (
        model.providerId !== state.binding.effectiveSelection.providerId ||
        model.modelId !== state.binding.effectiveSelection.modelId
      )
        throw new GatewayError(403, "model_identity_mismatch");
      const context = {
        requestId: randomUUID(),
        modelId: decoded.modelId,
        createdAt: Math.floor(Date.now() / 1000),
        signal: controller.signal,
      };
      const frames = protocol.encode(
        model.streamText({ ...decoded.request, abortSignal: controller.signal }),
        context,
      );
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      for await (const frame of frames) {
        if (controller.signal.aborted) break;
        const data = serialize(frame, state.binding.maxOutputBytes - state.outputBytes);
        if (data.length > state.binding.maxOutputBytes - state.outputBytes)
          throw new GatewayError(429, "output_budget_exceeded");
        state.outputBytes += data.length;
        if (!res.write(data)) await waitForDrain(res, controller.signal);
      }
      if (!controller.signal.aborted) res.end();
    } catch (error) {
      const failure = safeError(error);
      try {
        observe?.({ code: failure.code, protocol: state?.binding.protocol });
      } catch {
        /* observation cannot change routing */
      }
      if (!controller?.signal.aborted) {
        if (res.headersSent && state) {
          const terminal = serialize(
            { event: "error", data: { error: { code: failure.code } } },
            512,
          );
          if (terminal.length <= state.binding.maxOutputBytes - state.outputBytes) {
            state.outputBytes += terminal.length;
            res.end(terminal);
          } else res.destroy();
        } else sendError(res, failure);
      }
    } finally {
      if (controller) {
        controller.signal.removeEventListener("abort", cancelled);
        state?.active.delete(controller);
        active--;
      }
      res.off("close", disconnected);
      req.off("aborted", disconnected);
    }
  });
  return {
    async start() {
      if (closing) throw new GatewayError(503, "gateway_closed");
      if (address) return address;
      starting ??= (async () => {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
          });
        });
        const socket = server.address();
        if (!socket || typeof socket === "string")
          throw new GatewayError(500, "gateway_bind_failed");
        address = { url: `http://127.0.0.1:${socket.port}`, port: socket.port };
        return address;
      })();
      return starting;
    },
    issueToken(binding: GatewayTokenBinding) {
      if (!address || closing) throw new GatewayError(503, "gateway_closed");
      validateBinding(binding);
      if (!options.protocols.some((protocol) => protocol.id === binding.protocol))
        throw new GatewayError(400, "invalid_protocol");
      const token = newToken();
      const copy = structuredClone(binding);
      if (copy.effectiveSelection.options) Object.freeze(copy.effectiveSelection.options);
      Object.freeze(copy.effectiveSelection);
      Object.freeze(copy);
      const state: TokenState = { binding: copy, requests: 0, outputBytes: 0, active: new Set() };
      tokens.set(token, state);
      const expire = () => {
        const remaining = copy.expiresAt - Date.now();
        if (remaining <= 0) {
          revoke(token);
          return;
        }
        state.timer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
        state.timer.unref();
      };
      expire();
      return token;
    },
    revokeToken: revoke,
    async close() {
      if (stopping) return stopping;
      closing = true;
      stopping = (async () => {
        if (starting) await starting.catch(() => {});
        for (const token of tokens.keys()) revoke(token);
        server.closeAllConnections();
        if (server.listening)
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
      })();
      return stopping;
    },
  };
}
