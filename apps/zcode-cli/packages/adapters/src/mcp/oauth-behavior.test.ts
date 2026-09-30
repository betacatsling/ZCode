/**
 * MCP OAuth 行为测试（M3 缺口第 1 条）。
 *
 * 用进程内 fake 授权服务器（127.0.0.1 随机端口）+ 临时凭据文件，跑真实的
 * discovery → DCR → authorize（PKCE/state）→ code exchange → refresh → 撤销 → 重新授权。
 * 只证明确定性语义，不代表任何真实 MCP 服务器 / 真实 IdP 的 live 认证。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { McpOAuthConfig } from "@zcode/contracts";
import {
  createSharedZCodeCredentialStore,
  LEGACY_PRODUCT_OAUTH_CREDENTIAL_KEYS,
  type SharedZCodeCredentialStore,
} from "../auth/shared-credentials.js";
import { createCredentialKeyPrefix } from "./oauth.js";
import {
  loadCanonicalCredentials,
  loadCredentialPair,
  mcpOAuthCredentialKey,
  publishCanonicalCredentials,
} from "./oauth-credentials.js";
import { runMcpInteractiveAuthorization } from "./oauth-interactive.js";
import { createMcpOAuthTokenProvider } from "./oauth-provider.js";

type AuthCodeConfig = Extract<McpOAuthConfig, { type: "authorization_code" }>;
type RefreshMode = "ok" | "unavailable";

interface IssuedCode {
  challenge: string;
  clientId: string;
  redirectUri: string;
}

/** 最小 OAuth 2.1 授权服务器 + MCP 受保护资源元数据。refresh token 轮换且检测复用。 */
class FakeAuthorizationServer {
  readonly clients = new Map<string, { redirectUris: string[] }>();
  readonly codes = new Map<string, IssuedCode>();
  readonly liveRefreshTokens = new Map<string, string>();
  readonly revokedRefreshTokens = new Set<string>();
  readonly requests: string[] = [];
  refreshMode: RefreshMode = "ok";
  refreshDelayMs = 0;
  accessTokenTtlSeconds = 3600;
  lastAuthorizeParams?: URLSearchParams;
  private counter = 0;
  private server?: Server;
  origin = "";

  get serverUrl(): string {
    return `${this.origin}/mcp`;
  }

  count(kind: string): number {
    return this.requests.filter((entry) => entry === kind).length;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        res.writeHead(500).end(String(error));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  /** 模拟浏览器：访问授权 URL，跟随 302 回到本地 callback listener。 */
  async approveInBrowser(authorizationUrl: string): Promise<void> {
    const response = await fetch(authorizationUrl, { redirect: "manual" });
    const location = response.headers.get("location");
    assert.equal(response.status, 302, "authorize endpoint must redirect back");
    assert.ok(location);
    const callback = await fetch(location);
    await callback.text();
  }

  private next(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.origin);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      this.requests.push("prm");
      json(200, { authorization_servers: [this.origin], resource: this.serverUrl });
      return;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      this.requests.push("as-metadata");
      json(200, {
        authorization_endpoint: `${this.origin}/authorize`,
        code_challenge_methods_supported: ["S256"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        issuer: this.origin,
        registration_endpoint: `${this.origin}/register`,
        response_types_supported: ["code"],
        token_endpoint: `${this.origin}/token`,
        token_endpoint_auth_methods_supported: ["none"],
      });
      return;
    }
    if (url.pathname === "/register" && req.method === "POST") {
      this.requests.push("register");
      const body = JSON.parse(await readBody(req)) as { redirect_uris: string[] };
      const clientId = this.next("dcr-client");
      this.clients.set(clientId, { redirectUris: body.redirect_uris });
      json(201, { ...body, client_id: clientId, client_id_issued_at: 1 });
      return;
    }
    if (url.pathname === "/authorize") {
      this.requests.push("authorize");
      this.lastAuthorizeParams = url.searchParams;
      const clientId = url.searchParams.get("client_id") ?? "";
      const redirectUri = url.searchParams.get("redirect_uri") ?? "";
      const client = this.clients.get(clientId);
      if (!client || !client.redirectUris.includes(redirectUri)) {
        res.writeHead(400).end("redirect_uri mismatch");
        return;
      }
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      const code = this.next("code");
      this.codes.set(code, {
        challenge: url.searchParams.get("code_challenge") ?? "",
        clientId,
        redirectUri,
      });
      const back = new URL(redirectUri);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }
    if (url.pathname === "/token" && req.method === "POST") {
      await this.handleToken(new URLSearchParams(await readBody(req)), json);
      return;
    }
    res.writeHead(404).end();
  }

  private async handleToken(
    form: URLSearchParams,
    json: (status: number, body: unknown) => void,
  ): Promise<void> {
    const grant = form.get("grant_type");
    const clientId = form.get("client_id") ?? "";
    if (!this.clients.has(clientId)) {
      this.requests.push(`token:${grant}`);
      json(401, { error: "invalid_client" });
      return;
    }
    if (grant === "authorization_code") {
      this.requests.push("token:authorization_code");
      const issued = this.codes.get(form.get("code") ?? "");
      this.codes.delete(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!issued || issued.challenge !== challenge || issued.clientId !== clientId) {
        json(400, { error: "invalid_grant" });
        return;
      }
      json(200, this.issueTokens(clientId));
      return;
    }
    this.requests.push("token:refresh_token");
    if (this.refreshDelayMs > 0) await sleep(this.refreshDelayMs);
    if (this.refreshMode === "unavailable") {
      json(503, { error: "temporarily_unavailable" });
      return;
    }
    const presented = form.get("refresh_token") ?? "";
    if (
      this.revokedRefreshTokens.has(presented) ||
      this.liveRefreshTokens.get(presented) !== clientId
    ) {
      // 轮换后的复用同样视为 grant 失效（reuse detection）。
      json(400, { error: "invalid_grant" });
      return;
    }
    this.liveRefreshTokens.delete(presented);
    this.revokedRefreshTokens.add(presented);
    json(200, this.issueTokens(clientId));
  }

  private issueTokens(clientId: string): Record<string, unknown> {
    const refreshToken = this.next("rt");
    this.liveRefreshTokens.set(refreshToken, clientId);
    return {
      access_token: this.next("at"),
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      token_type: "Bearer",
    };
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface Harness {
  as: FakeAuthorizationServer;
  config: AuthCodeConfig;
  dir: string;
  filePath: string;
  keyPrefix: string;
  serverName: string;
  store: SharedZCodeCredentialStore;
  /** 同一凭据文件的另一个 store 实例，模拟另一个进程。 */
  openStore(): SharedZCodeCredentialStore;
}

const LEGACY_SEED: Record<string, string> = Object.fromEntries(
  LEGACY_PRODUCT_OAUTH_CREDENTIAL_KEYS.map((key) => [key, `legacy-product-${key}`]),
);

async function withHarness(
  run: (harness: Harness) => Promise<void>,
  options: { config?: Partial<AuthCodeConfig> } = {},
): Promise<void> {
  const as = new FakeAuthorizationServer();
  await as.start();
  const dir = await mkdtemp(join(tmpdir(), "zcode-mcp-oauth-behavior-"));
  const filePath = join(dir, "credentials.json");
  // 旧产品登录键原样留盘：MCP OAuth 全流程不应读、改、删它们。
  await writeFile(filePath, JSON.stringify(LEGACY_SEED), "utf8");
  const openStore = () => createSharedZCodeCredentialStore({ env: {}, filePath });
  const serverName = "fixture-mcp";
  const config: AuthCodeConfig = { type: "authorization_code", ...options.config };
  try {
    await run({
      as,
      config,
      dir,
      filePath,
      keyPrefix: createCredentialKeyPrefix(serverName, as.serverUrl, config),
      openStore,
      serverName,
      store: openStore(),
    });
    const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, string>;
    for (const [key, value] of Object.entries(LEGACY_SEED)) {
      assert.equal(raw[key], value, `legacy product key ${key} must stay untouched`);
    }
    for (const key of Object.keys(raw)) {
      assert.ok(key in LEGACY_SEED || key.startsWith("mcp:oauth:"), `unexpected key ${key}`);
    }
  } finally {
    await as.stop();
    await rm(dir, { force: true, recursive: true });
  }
}

async function authorize(h: Harness, store = h.store) {
  const seenContexts: string[] = [];
  const outcome = await runMcpInteractiveAuthorization({
    config: h.config,
    credentialStore: store,
    keyPrefix: h.keyPrefix,
    openAuthorizationUrl: async (context) => {
      seenContexts.push(context.redirectUrl);
      await h.as.approveInBrowser(context.authorizationUrl);
    },
    serverName: h.serverName,
    serverUrl: h.as.serverUrl,
    transactionTtlMs: 10_000,
  });
  return { outcome, seenContexts };
}

/** Phase 1 AuthProvider；onUnauthorized 的 SDK 上下文参数在实现里不被读取。 */
function tokenProvider(h: Harness, store = h.store) {
  const provider = createMcpOAuthTokenProvider({
    config: h.config,
    credentialStore: store,
    keyPrefix: h.keyPrefix,
    serverName: h.serverName,
    serverUrl: h.as.serverUrl,
  });
  const onUnauthorized = provider.onUnauthorized;
  assert.ok(onUnauthorized, "token provider must implement onUnauthorized");
  return {
    onUnauthorized: async (): Promise<void> => await onUnauthorized.call(provider, {} as never),
    token: async (): Promise<string | undefined> => await provider.token(),
  };
}

/** 直接发布一对「已临期」凭据，作为 refresh 场景的起点。 */
async function seedNearExpiryPair(
  h: Harness,
): Promise<{ accessToken: string; refreshToken: string }> {
  const clientId = "dcr-client-seed";
  h.as.clients.set(clientId, { redirectUris: [] });
  h.as.liveRefreshTokens.set("rt-seed", clientId);
  await publishCanonicalCredentials(h.store, h.keyPrefix, {
    clientInformation: { client_id: clientId },
    publishedBy: "test-seed",
    tokens: {
      access_token: "at-seed",
      expires_in: 5,
      refresh_token: "rt-seed",
      token_type: "Bearer",
    },
  });
  return { accessToken: "at-seed", refreshToken: "rt-seed" };
}

function assertInteractiveRequired(reason: string) {
  return (error: unknown) => {
    const e = error as { code?: string; reason?: string };
    assert.equal(e.code, "MCP_OAUTH_INTERACTIVE_REQUIRED");
    assert.equal(e.reason, reason);
    return true;
  };
}

test("authorize: discovery, DCR, PKCE and state round trip publish a canonical pair", async () => {
  await withHarness(async (h) => {
    assert.equal(await tokenProvider(h).token(), undefined, "no credentials before authorization");
    await assert.rejects(
      tokenProvider(h).onUnauthorized(),
      assertInteractiveRequired("no_credentials"),
    );

    const { outcome, seenContexts } = await authorize(h);
    assert.deepEqual(outcome, { status: "authorized" });
    assert.equal(seenContexts.length, 1);
    assert.match(
      seenContexts[0]!,
      /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\/mcp\/fixture-mcp$/,
    );
    assert.deepEqual(
      ["register", "authorize", "token:authorization_code"].map((kind) => h.as.count(kind)),
      [1, 1, 1],
    );
    assert.ok(h.as.lastAuthorizeParams?.get("state"), "authorize request carries state");
    assert.equal(h.as.lastAuthorizeParams?.get("resource"), h.as.serverUrl);

    const canonical = await loadCanonicalCredentials(h.store, h.keyPrefix);
    assert.ok(canonical?.tokens?.refresh_token, "refresh token persisted");
    assert.ok(canonical.clientInformation?.client_id?.startsWith("dcr-client-"));
    assert.ok(canonical.expiresAt && canonical.expiresAt > Date.now() + 3_000_000);
    // 非临期：token() 直接返回现值，不打 token 端点。
    assert.equal(await tokenProvider(h).token(), canonical.tokens.access_token);
    assert.equal(h.as.count("token:refresh_token"), 0);
    // pending 事务键在成功后被清掉。
    const pendingKeys = Object.keys(JSON.parse(await readFile(h.filePath, "utf8"))).filter((key) =>
      key.includes("pending"),
    );
    assert.deepEqual(pendingKeys, []);
  });
});

test("authorize: a callback with a foreign state is ignored and the real one still completes", async () => {
  await withHarness(async (h) => {
    const outcome = await runMcpInteractiveAuthorization({
      config: h.config,
      credentialStore: h.store,
      keyPrefix: h.keyPrefix,
      openAuthorizationUrl: async (context) => {
        const forged = new URL(context.redirectUrl);
        forged.searchParams.set("code", "attacker-code");
        forged.searchParams.set("state", "not-the-transaction-state");
        const rejected = await fetch(forged);
        await rejected.text();
        assert.equal(rejected.status, 400);
        await h.as.approveInBrowser(context.authorizationUrl);
      },
      serverName: h.serverName,
      serverUrl: h.as.serverUrl,
      transactionTtlMs: 10_000,
    });
    assert.deepEqual(outcome, { status: "authorized" });
    assert.equal(h.as.count("token:authorization_code"), 1, "forged code never reaches /token");
  });
});

test("refresh: near-expiry token() rotates the pair and publishes a new generation", async () => {
  await withHarness(async (h) => {
    const seed = await seedNearExpiryPair(h);
    const before = await loadCanonicalCredentials(h.store, h.keyPrefix);
    const next = await tokenProvider(h).token();
    assert.ok(next && next !== seed.accessToken);
    assert.equal(h.as.count("token:refresh_token"), 1);
    const after = await loadCanonicalCredentials(h.store, h.keyPrefix);
    assert.notEqual(after?.generation, before?.generation);
    assert.equal(after?.tokens?.access_token, next);
    assert.notEqual(after?.tokens?.refresh_token, seed.refreshToken, "refresh token rotated");
    assert.equal(
      after?.clientInformation?.client_id,
      "dcr-client-seed",
      "client kept across refresh",
    );
    // 新 token 不临期：再次 token() 不再刷新。
    assert.equal(await tokenProvider(h).token(), next);
    assert.equal(h.as.count("token:refresh_token"), 1);
  });
});

test("refresh: onUnauthorized forces a reactive refresh even when the token looks fresh", async () => {
  await withHarness(async (h) => {
    await authorize(h);
    const provider = tokenProvider(h);
    const first = await provider.token();
    await provider.onUnauthorized();
    const second = await provider.token();
    assert.ok(second && second !== first);
    assert.equal(h.as.count("token:refresh_token"), 1);
  });
});

test("refresh: concurrent refreshes from two store instances coalesce into one token request", async () => {
  await withHarness(async (h) => {
    await seedNearExpiryPair(h);
    h.as.refreshDelayMs = 150;
    const [a, b] = await Promise.all([
      tokenProvider(h, h.openStore()).token(),
      tokenProvider(h, h.openStore()).token(),
    ]);
    assert.ok(a);
    assert.equal(a, b, "both callers observe the single winner's token");
    assert.equal(h.as.count("token:refresh_token"), 1, "rotated refresh token is never replayed");
  });
});

test("revoke: invalid_grant clears tokens, keeps the client, then re-authorization recovers", async () => {
  await withHarness(async (h) => {
    await authorize(h);
    const authorized = await loadCanonicalCredentials(h.store, h.keyPrefix);
    h.as.revokedRefreshTokens.add(authorized!.tokens!.refresh_token!);

    await assert.rejects(
      tokenProvider(h).onUnauthorized(),
      assertInteractiveRequired("invalid_grant"),
    );
    assert.equal(await loadCanonicalCredentials(h.store, h.keyPrefix), undefined);
    const clientRaw = await h.store.load(mcpOAuthCredentialKey(h.keyPrefix, "client_information"));
    assert.ok(clientRaw?.includes(authorized!.clientInformation!.client_id), "client seed kept");
    assert.equal((await loadCredentialPair(h.store, h.keyPrefix))?.tokens, undefined);
    assert.equal(await tokenProvider(h).token(), undefined, "revoked grant yields no token");
    await assert.rejects(
      tokenProvider(h).onUnauthorized(),
      assertInteractiveRequired("no_credentials"),
    );

    const again = await authorize(h);
    assert.deepEqual(again.outcome, { status: "authorized" });
    const recovered = await loadCanonicalCredentials(h.store, h.keyPrefix);
    assert.ok(recovered?.tokens?.access_token);
    assert.notEqual(recovered.generation, authorized!.generation);
    assert.equal(await tokenProvider(h).token(), recovered.tokens.access_token);
  });
});

test("revoke: proactive refresh that hits invalid_grant also fails closed", async () => {
  await withHarness(async (h) => {
    const seed = await seedNearExpiryPair(h);
    h.as.revokedRefreshTokens.add(seed.refreshToken);
    await assert.rejects(tokenProvider(h).token(), assertInteractiveRequired("invalid_grant"));
    assert.equal(await tokenProvider(h).token(), undefined);
  });
});

test("revoke: invalid_client for a DCR client drops the whole pair", async () => {
  await withHarness(async (h) => {
    await seedNearExpiryPair(h);
    h.as.clients.delete("dcr-client-seed");
    await assert.rejects(tokenProvider(h).token(), assertInteractiveRequired("invalid_client"));
    assert.equal(await loadCredentialPair(h.store, h.keyPrefix), undefined);
    assert.equal(
      await h.store.load(mcpOAuthCredentialKey(h.keyPrefix, "client_information")),
      null,
    );
  });
});

test("revoke: invalid_client for a static clientId is a config error and keeps credentials", async () => {
  await withHarness(
    async (h) => {
      await seedNearExpiryPair(h);
      h.as.clients.delete("dcr-client-seed");
      await assert.rejects(tokenProvider(h).onUnauthorized(), /configured clientId is not usable/);
      assert.equal(
        (await loadCanonicalCredentials(h.store, h.keyPrefix))?.tokens?.access_token,
        "at-seed",
      );
    },
    { config: { clientId: "static-client" } },
  );
});

test("temporary AS failure: proactive refresh is fail-soft, reactive refresh is a temporary error", async () => {
  await withHarness(async (h) => {
    const seed = await seedNearExpiryPair(h);
    h.as.refreshMode = "unavailable";
    const before = await loadCanonicalCredentials(h.store, h.keyPrefix);
    assert.equal(
      await tokenProvider(h).token(),
      seed.accessToken,
      "proactive keeps the current token",
    );
    await assert.rejects(tokenProvider(h).onUnauthorized(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "MCP_OAUTH_TEMPORARY_REFRESH_FAILURE");
      return true;
    });
    const after = await loadCanonicalCredentials(h.store, h.keyPrefix);
    assert.equal(after?.generation, before?.generation, "a transient failure never invalidates");
    assert.equal(after?.tokens?.refresh_token, seed.refreshToken);

    h.as.refreshMode = "ok";
    await tokenProvider(h).onUnauthorized();
    assert.notEqual(
      (await loadCanonicalCredentials(h.store, h.keyPrefix))?.tokens?.access_token,
      seed.accessToken,
    );
  });
});
