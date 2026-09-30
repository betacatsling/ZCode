# Web P3 entry stub (product OAuth)

基线：wave4 tip（含 #20/#21/#22）。

## Scope（入口 stub，已被下方 deletion 取代）

入口 stub 曾让 `webAuthService.startLogin` 不再跳转，`/share/callback` 仍挂 `WebCallbackPage`。该实现已删除，当前行为以「P3 leftover deletion」为准。`productLoginRemoved.ts` 仍是共享文案。

## Out of scope

- 不碰 `packages/services` `node.ts` / oauth 装配（P2 @ex6）
- 不碰 Desktop deep link / CLI（#21 已入库）
- 不碰 Claude / Gateway / Devin / Pi、UI settings / Coding Plan

## P3 leftover deletion

产品浏览器 OAuth 实现已从 `packages/web` 删除。分享页是「已移除」文案的唯一展示处，不再构造授权客户端或浏览器凭据仓库。

- 保留 `packages/web/src/auth/productLoginRemoved.ts`
- 删除 `webAuthService.ts`、`browserOAuthCredentialRepo.ts`、`zaiWebOAuthProvider.ts`、`webZaiOAuthConfig.ts`、`oauthStateCodec.ts`、`WebCallbackPage.tsx`、`webAuthLocale.ts`
- `/share/callback` 不再挂 `WebCallbackPage`
- 分享 token 只有 mock session 或 `null`；logout 不碰产品凭据仓库
- `login_required` / `authentication_required` 展示 `PRODUCT_LOGIN_REMOVED_MESSAGE`，不发起 authorize
