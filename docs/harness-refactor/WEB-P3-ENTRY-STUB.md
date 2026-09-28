# Web P3 entry stub (product OAuth)

基线：wave4 tip（含 #20/#21/#22）。

## Scope（本 PR）

- `packages/web/src/auth/webAuthService.ts`：`startLogin` 不再跳转授权；`handleCallback` 抛「已移除」；`getZCodeJwtToken` 恒 `null`
- `packages/web/src/auth/productLoginRemoved.ts`：共享文案
- `packages/web/src/main.tsx`：分享页 `onLogin` 弹窗提示，不调产品 OAuth
- callback 路由仍挂 `WebCallbackPage`，会显示 `handleCallback` 抛错文案

## Out of scope

- 不删 `packages/web/src/auth/**` 文件（完整删除等后续）
- 不碰 `packages/services` `node.ts` / oauth 装配（P2 @ex6）
- 不碰 Desktop deep link / CLI（#21 已入库）
