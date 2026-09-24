import { randomBytes, timingSafeEqual } from "node:crypto";

/** Main-owned consent state, never a Core/Host business owner or renderer authorization claim. */
interface PhoneScope {
  windowId: number;
  workspacePath: string;
  workspaceIdentity?: string;
  origin: string;
}
interface BoundScope {
  windowId: number;
  workspacePath: string;
  workspaceKey: string;
  origin: string;
  host: object;
}
interface Challenge {
  value: string;
  expires: number;
  attempts: number;
  scope: BoundScope;
}
interface Principal {
  scope: BoundScope;
  expires: number;
  closeViews: Set<() => void>;
  expiryTimer: ReturnType<typeof setTimeout>;
}
const DENIED = "phone attachment denied";
const CHALLENGE_LIFETIME_MS = 120_000;
const CREDENTIAL_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_ATTEMPTS = 5;

function equalSecret(a: string, b: string): boolean {
  if (typeof a !== "string" || a.length > 128 || typeof b !== "string") return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function checkOrigin(origin: string): void {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error("invalid phone Origin");
  }
  if (url.origin !== origin || url.username || url.password || url.pathname !== "/") {
    throw new Error("invalid phone Origin");
  }
  if (url.protocol === "https:") return;
  if (
    url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]")
  )
    return;
  throw new Error("phone attachment requires TLS for nonloopback Origin");
}
function sameScope(scope: BoundScope, input: PhoneScope, host: object | undefined): boolean {
  return (
    scope.host === host &&
    scope.windowId === input.windowId &&
    scope.workspacePath === input.workspacePath &&
    scope.workspaceKey === (input.workspaceIdentity?.trim() || input.workspacePath) &&
    scope.origin === input.origin
  );
}

export function createPhoneAttachmentConsent(options: {
  /** Main window-scoped Host map; never accept this value from a browser. */
  currentHost(windowId: number): object | undefined;
  clock?: () => number;
  randomSecret?: () => string;
}) {
  let enabled = false;
  const clock = options.clock ?? Date.now;
  const randomSecret = options.randomSecret ?? (() => randomBytes(32).toString("base64url"));
  const challenges = new Map<number, Challenge>();
  const principals = new Map<string, Principal>();
  function requireEnabled(): void {
    if (!enabled) throw new Error("phone attachment disabled");
  }
  function closePrincipal(credential: string): void {
    const principal = principals.get(credential);
    if (!principal) return;
    principals.delete(credential);
    clearTimeout(principal.expiryTimer);
    for (const close of principal.closeViews) {
      try {
        close();
      } catch {
        // 中文：一个端口关闭失败不能留下同一设备的其它活跃视图；撤销必须继续。
      }
    }
    principal.closeViews.clear();
  }
  function revokeWindow(windowId: number): void {
    challenges.delete(windowId);
    for (const [credential, principal] of principals) {
      if (principal.scope.windowId === windowId) closePrincipal(credential);
    }
  }
  return {
    setEnabled(value: boolean): void {
      if (!value) {
        for (const id of challenges.keys()) revokeWindow(id);
        for (const credential of principals.keys()) closePrincipal(credential);
      }
      enabled = value;
    },
    /** Only a desktop-consent handler may call this; never expose this method to browser RPC. */
    beginConsent(input: PhoneScope): string {
      requireEnabled();
      checkOrigin(input.origin);
      const host = options.currentHost(input.windowId);
      if (
        !host ||
        !Number.isSafeInteger(input.windowId) ||
        !input.workspacePath ||
        !(input.workspaceIdentity?.trim() || input.workspacePath)
      ) {
        throw new Error(DENIED);
      }
      // 中文：重新授权时旧凭据和活跃视图必须立即失效，不能让两个代际同时写同一个 Host。
      revokeWindow(input.windowId);
      const value = randomSecret();
      challenges.set(input.windowId, {
        value,
        scope: {
          windowId: input.windowId,
          host,
          origin: input.origin,
          workspacePath: input.workspacePath,
          workspaceKey: input.workspaceIdentity?.trim() || input.workspacePath,
        },
        expires: clock() + CHALLENGE_LIFETIME_MS,
        attempts: 0,
      });
      return value;
    },
    pair(input: PhoneScope & { challenge: string }): string {
      requireEnabled();
      const pending = challenges.get(input.windowId);
      if (!pending) throw new Error(DENIED);
      if (pending.expires <= clock()) {
        challenges.delete(input.windowId);
        throw new Error(DENIED);
      }
      if (
        !sameScope(pending.scope, input, options.currentHost(input.windowId)) ||
        !equalSecret(pending.value, input.challenge)
      ) {
        pending.attempts++;
        if (pending.attempts >= MAX_ATTEMPTS) challenges.delete(input.windowId);
        throw new Error(DENIED);
      }
      challenges.delete(input.windowId);
      const credential = randomSecret();
      const expiryTimer = setTimeout(() => closePrincipal(credential), CREDENTIAL_LIFETIME_MS);
      expiryTimer.unref();
      principals.set(credential, {
        scope: pending.scope,
        expires: clock() + CREDENTIAL_LIFETIME_MS,
        closeViews: new Set(),
        expiryTimer,
      });
      return credential;
    },
    /** Validates synchronously *before* Main creates/transfers a Host attachment port. */
    attach(input: PhoneScope & { credential: string }, close: () => void): () => void {
      requireEnabled();
      const principal =
        typeof input.credential === "string" && input.credential.length <= 128
          ? principals.get(input.credential)
          : undefined;
      if (!principal) throw new Error(DENIED);
      if (
        principal.expires <= clock() ||
        principal.scope.host !== options.currentHost(principal.scope.windowId)
      ) {
        // 中文：Host 换代/过期后立即关闭旧订阅，不能只阻止下一次登录。
        closePrincipal(input.credential);
        throw new Error(DENIED);
      }
      if (!sameScope(principal.scope, input, options.currentHost(input.windowId))) {
        throw new Error(DENIED);
      }
      principal.closeViews.add(close);
      return () => principal.closeViews.delete(close);
    },
    revoke(credential: string): void {
      closePrincipal(credential);
    },
    revokeWindow,
    dispose(): void {
      this.setEnabled(false);
    },
  };
}
