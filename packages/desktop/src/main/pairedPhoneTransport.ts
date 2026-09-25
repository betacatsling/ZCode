import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { MessagePortMain } from "electron";
import type { SessionOwner } from "@zcode/services";
import { Emitter, MessagePortProtocol, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { createPhoneAttachmentConsent } from "./phoneAttachmentConsent.js";
import { pairedPhonePort } from "./pairedPhonePort.js";

export interface PairedPhoneScope {
  windowId: number;
  targetId: string;
  workspaceId: string;
  hostSessionId: string;
  workspacePath: string;
  workspaceIdentity: string;
}
const DENIED = "phone attachment denied";
const MAX_BODY = 512;
function constantEqual(a: string, b: string): boolean {
  if (!a || a.length > 128 || !b || b.length > 128) return false;
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function wrapSocket(ws: WebSocket): ISocket {
  const data = new Emitter<VSBuffer>();
  const close = new Emitter<void>();
  ws.on("message", (raw, binary) => {
    if (!binary || !Buffer.isBuffer(raw) || raw.byteLength > 1024 * 1024) {
      ws.close(1009);
      return;
    }
    data.fire(VSBuffer.wrap(new Uint8Array(raw)));
  });
  ws.once("close", () => close.fire());
  ws.once("error", () => close.fire());
  return {
    onData: data.event,
    onClose: close.event,
    onEnd: close.event,
    write(buffer) {
      if (ws.readyState === ws.OPEN) ws.send(buffer.buffer);
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}
function bridge(port: MessagePortMain, ws: WebSocket): () => void {
  const host = new MessagePortProtocol(pairedPhonePort(port));
  const socket = new SocketProtocol(wrapSocket(ws));
  const fromHost = host.onMessage((data) => socket.send(data));
  const fromBrowser = socket.onMessage((data) => host.send(data));
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    fromHost.dispose();
    fromBrowser.dispose();
    socket.dispose();
    host.disconnect();
    ws.close();
  };
  port.once("close", close);
  ws.once("close", close);
  return close;
}
function cookie(req: IncomingMessage): string {
  const entry = req.headers.cookie
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("zcode_phone="));
  return entry?.slice("zcode_phone=".length) ?? "";
}
async function body(req: IncomingMessage): Promise<string> {
  let result = "";
  for await (const part of req) {
    result += part.toString("utf8");
    if (result.length > MAX_BODY) throw new Error(DENIED);
  }
  return result;
}

/** Main transport only. The selected Core owner and business journal remain in the existing Host. */
export function createPairedPhoneTransport(options: {
  currentHost(windowId: number): object | undefined;
  certify(scope: PairedPhoneScope): Promise<Extract<SessionOwner, { kind: "external" }>>;
  attachPort(scope: PairedPhoneScope): MessagePortMain;
  rendererRoot?: string;
}) {
  const consent = createPhoneAttachmentConsent({ currentHost: options.currentHost });
  let active:
    | (PairedPhoneScope & { origin: string; owner: Extract<SessionOwner, { kind: "external" }> })
    | null = null;
  let listener: ReturnType<typeof createServer> | null = null;
  let wsServer: WebSocketServer | null = null;
  let epoch = 0;
  const csrf = new Map<string, string>();
  const activeViews = new Set<() => void>();
  function revoke(): void {
    // 中文：异步 Core 认证仍在途时，撤销必须使它的后续监听/凭据创建失效。
    epoch++;
    for (const close of activeViews) close();
    activeViews.clear();
    csrf.clear();
    consent.setEnabled(false);
    active = null;
    wsServer?.close();
    wsServer = null;
    listener?.close();
    listener = null;
  }
  function scope() {
    if (!active || options.currentHost(active.windowId) !== host) throw new Error(DENIED);
    return active;
  }
  let host: object | undefined;
  function authorized(req: IncomingMessage): string {
    const selected = scope();
    if (
      req.headers.origin !== selected.origin ||
      req.headers.host !== new URL(selected.origin).host
    )
      throw new Error(DENIED);
    const credential = cookie(req);
    // Validate current principal even for static session reads; never trust a cookie by itself.
    consent.attach({ ...selected, credential }, () => {})();
    return credential;
  }
  const staticHeaders = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; frame-ancestors 'none'",
  };
  const respond = (res: ServerResponse, status: number, content = "") => {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      ...staticHeaders,
    });
    res.end(content);
  };
  async function serve(req: IncomingMessage, res: ServerResponse) {
    try {
      const selected = scope();
      if (req.headers.host !== new URL(selected.origin).host || !req.url || req.url.includes("?"))
        throw new Error(DENIED);
      if (req.method === "POST" && req.url === "/pair") {
        if (
          req.headers.origin !== selected.origin ||
          req.headers["x-zcode-phone-csrf"] !== "pair-v1" ||
          req.headers["content-type"] !== "text/plain;charset=UTF-8"
        )
          throw new Error(DENIED);
        const challenge = await body(req);
        const credential = consent.pair({ ...selected, challenge });
        const proof = randomBytes(24).toString("base64url");
        csrf.set(credential, proof);
        res.writeHead(200, {
          ...staticHeaders,
          "content-type": "application/json",
          "set-cookie": `zcode_phone=${credential}; HttpOnly; SameSite=Strict; Path=/`,
          "x-content-type-options": "nosniff",
        });
        res.end(JSON.stringify({ csrf: proof }));
        return;
      }
      if (req.method === "POST" && req.url === "/session") {
        if (req.headers["x-zcode-phone-csrf"] !== "session-v1") throw new Error(DENIED);
        const credential = authorized(req);
        res.writeHead(200, { ...staticHeaders, "content-type": "application/json" });
        res.end(JSON.stringify({ csrf: csrf.get(credential), owner: selected.owner }));
        return;
      }
      if (req.method !== "GET" || !options.rendererRoot) throw new Error(DENIED);
      // Only the inert pairing page and own hashed build assets are public; no Core data or file browsing.
      const name = req.url === "/" ? "paired-phone.html" : req.url.slice(1);
      if (name !== "paired-phone.html" && !/^assets\/[A-Za-z0-9_.-]+$/.test(name))
        throw new Error(DENIED);
      const root = resolve(options.rendererRoot);
      const file = resolve(root, name);
      if (!file.startsWith(root + sep)) throw new Error(DENIED);
      const bytes = await readFile(file);
      res.writeHead(200, {
        ...staticHeaders,
        "content-type":
          (
            {
              ".html": "text/html",
              ".js": "text/javascript",
              ".css": "text/css",
              ".png": "image/png",
            } as Record<string, string>
          )[extname(file)] ?? "application/octet-stream",
      });
      res.end(bytes);
    } catch {
      respond(res, 403);
    }
  }
  return {
    address(): string | null {
      return active?.origin ?? null;
    },
    async enable(selection?: PairedPhoneScope): Promise<{ origin: string; challenge: string }> {
      if (!selection || !options.currentHost(selection.windowId))
        throw new Error("phone scope/host consent required");
      revoke();
      const requestEpoch = epoch;
      const candidateHost = options.currentHost(selection.windowId);
      const owner = await options.certify(selection);
      if (
        epoch !== requestEpoch ||
        !candidateHost ||
        candidateHost !== options.currentHost(selection.windowId)
      )
        throw new Error(DENIED);
      // No listener, challenge or credential exists until the existing Host certifies the selected owner.
      const server = createServer((req, res) => {
        void serve(req, res);
      });
      const upgrader = new WebSocketServer({
        noServer: true,
        maxPayload: 1024 * 1024,
        handleProtocols: (protocols) =>
          protocols.has("zcode-phone-v1") ? "zcode-phone-v1" : false,
      });
      server.on("upgrade", (req, socket, head) => {
        try {
          if (
            req.url !== "/rpc" ||
            !req.headers.origin ||
            req.headers.origin !== active?.origin ||
            req.headers.host !== new URL(active.origin).host
          )
            throw new Error(DENIED);
          const credential = cookie(req);
          // Browser WS cannot send custom headers: the CSRF proof is a second subprotocol, never a URL.
          const protocols =
            req.headers["sec-websocket-protocol"]?.split(",").map((p) => p.trim()) ?? [];
          if (
            protocols[0] !== "zcode-phone-v1" ||
            !csrf.has(credential) ||
            protocols.length !== 2 ||
            !constantEqual(protocols[1]!, csrf.get(credential)!)
          )
            throw new Error(DENIED);
          const selected = scope();
          let release = () => {};
          let revoked = false;
          let close = () => {
            revoked = true;
            socket.destroy();
          };
          release = consent.attach({ ...selected, credential }, () => close());
          // 中文：升级异步回调前可能发生撤销；不得在已撤销套接字上再转移 Host port。
          if (options.currentHost(selected.windowId) !== host) throw new Error(DENIED);
          upgrader.handleUpgrade(req, socket, head, (ws) => {
            try {
              if (revoked || options.currentHost(selected.windowId) !== host)
                throw new Error(DENIED);
              close = bridge(options.attachPort(selected), ws);
              activeViews.add(close);
              ws.once("close", () => {
                activeViews.delete(close);
                release();
              });
            } catch {
              ws.close();
              release();
            }
          });
        } catch {
          socket.destroy();
        }
      });
      try {
        await new Promise<void>((ok, fail) => {
          server.once("error", fail);
          server.listen(0, "127.0.0.1", ok);
        });
        if (epoch !== requestEpoch || candidateHost !== options.currentHost(selection.windowId))
          throw new Error(DENIED);
        const port = (server.address() as AddressInfo).port;
        const origin = `http://127.0.0.1:${port}`;
        host = candidateHost;
        active = { ...selection, origin, owner };
        listener = server;
        wsServer = upgrader;
        consent.setEnabled(true);
        const challenge = consent.beginConsent(active);
        return { origin, challenge };
      } catch (error) {
        server.close();
        upgrader.close();
        // 中文：较旧请求失败不得撤销较新一轮已成功的授权。
        if (epoch === requestEpoch) revoke();
        throw error;
      }
    },
    disable: revoke,
    revokeSelection(selection: PairedPhoneScope) {
      if (
        active &&
        active.windowId === selection.windowId &&
        active.workspaceId === selection.workspaceId &&
        active.hostSessionId === selection.hostSessionId &&
        active.workspaceIdentity === selection.workspaceIdentity &&
        active.workspacePath === selection.workspacePath
      )
        revoke();
    },
    revokeWindow(windowId: number) {
      if (active?.windowId === windowId) revoke();
    },
    dispose: revoke,
  };
}
