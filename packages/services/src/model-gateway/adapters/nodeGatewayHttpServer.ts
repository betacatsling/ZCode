import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type {
  GatewayHttpHandler,
  GatewayHttpResponse,
  GatewayHttpServerPort,
} from "../app/transport.js";

function waitForDrainOrClose(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      response.off("drain", finish);
      response.off("close", finish);
      response.off("error", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
    response.once("error", finish);
    if (response.destroyed) finish();
  });
}

async function discardBody(body: GatewayHttpResponse["body"] | undefined): Promise<void> {
  if (body === undefined || typeof body === "string") return;
  for await (const _chunk of body) {
    /* draining a cancelled response runs its application cleanup */
  }
}

async function send(
  request: IncomingMessage,
  response: ServerResponse,
  handler: GatewayHttpHandler,
): Promise<void> {
  const abortController = new AbortController();
  const abort = () => abortController.abort();
  const cleanup = () => {
    request.off("aborted", abort);
    response.off("close", onClose);
    response.off("finish", cleanup);
  };
  const onClose = () => {
    if (!response.writableEnded) abort();
    cleanup();
  };
  request.once("aborted", abort);
  response.once("close", onClose);
  response.once("finish", cleanup);
  let pendingBody: GatewayHttpResponse["body"] | undefined;
  try {
    const result = await handler.handle({
      method: request.method ?? "",
      path: request.url ?? "",
      authorization: request.headers.authorization,
      apiKey: singleHeader(request.headers["x-api-key"]),
      anthropicVersion: singleHeader(request.headers["anthropic-version"]),
      anthropicBeta: singleHeader(request.headers["anthropic-beta"]),
      anthropicDirectBrowserAccess: singleHeader(
        request.headers["anthropic-dangerous-direct-browser-access"],
      ),
      contentType: singleHeader(request.headers["content-type"]),
      contentLength: request.headers["content-length"],
      body: request,
      signal: abortController.signal,
    });
    pendingBody = result.body;
    if (abortController.signal.aborted || response.destroyed) {
      await discardBody(pendingBody);
      pendingBody = undefined;
      request.resume();
      return;
    }
    response.writeHead(result.status, result.headers);
    if (typeof result.body === "string") {
      pendingBody = undefined;
      response.end(result.body);
      return;
    }
    for await (const chunk of result.body) {
      if (abortController.signal.aborted || response.destroyed) break;
      if (!response.write(chunk)) {
        await waitForDrainOrClose(response);
      }
    }
    pendingBody = undefined;
    if (!response.destroyed && !response.writableEnded) response.end();
  } catch {
    abort();
    try {
      await discardBody(pendingBody);
    } catch {
      /* the cancelled body is already closed */
    }
    pendingBody = undefined;
    if (!response.destroyed && !response.writableEnded) {
      response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      response.end(
        '{"error":{"type":"server_error","code":"model_error","message":"Gateway request failed"}}',
      );
    }
  } finally {
    if (!request.readableEnded) request.resume();
    cleanup();
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function createNodeGatewayHttpServer(): GatewayHttpServerPort {
  let server: Server | undefined;
  return {
    async listen(input) {
      if (server) throw new Error("Gateway HTTP server already started");
      server = createServer((request, response) => {
        void send(request, response, input.handler);
      });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(input.port, input.host, () => {
          server!.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Gateway did not bind a TCP address");
      const host = input.host === "::1" ? "[::1]" : "127.0.0.1";
      return { baseUrl: "http://" + host + ":" + address.port };
    },
    async close() {
      if (!server) return;
      const current = server;
      server = undefined;
      await new Promise<void>((resolve, reject) =>
        current.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
