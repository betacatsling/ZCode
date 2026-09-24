# ssh-package public contract

Interface/spec commit: `95d3b38e1c8be20ba519ec8bcae25acfb3e730fd`; implementation commit: `621b37574159a3e875a07c641bc1190e04a85e22`.

Import `@zcode/server/remote`:
```ts
interface SshCoreAttachmentTransport {
  detect(): Promise<{ platform: string; arch: string }>;
  exec(command: string): Promise<StdioStream>;
  openLoopbackTunnel(port: number): Promise<{ endpoint: string; dispose(): void }>;
}
function attachInstalledSshCore(
  backend: SshCoreAttachmentTransport,
  expected: { serverId: string; version: string },
): Promise<{
  serverId: string;
  websocketUrl: string; // /ws/host over disposable local loopback forward
  ticket: string; // one use; upgrade promptly using ZCODE_RPC_HOST_CAPABILITY_HEADER
  expiresAt: number;
  dispose(): void; // tunnel only, NEVER stops target Core
}>;
```
Existing `SSHBackend` implements this transport directly. The helper starts/reuses the installed Core with a fixed short `serve --daemon --json` exec; validates ready receipt, tunneled server identity/version/protocol and Host capability *before* issuing ticket. Caller still owns trusted WS upgrade/window-scoped Host attachment and must supply expected installed identity/version, not infer them from the untrusted handshake. Do not use a separate SSH Harness Host.

Linux closure: `stageRelease` stages `bin/zcode`, `runtime/{node,server-cli.js,server-core.js,piWorker.js,zcode.cjs,node_modules}`; launcher belongs to server-runtime component. `node packages/zcode-server-cli/scripts/verify-linux-closure.mjs <release-dir>` checks manifest, component coverage, executable bits and all symlinks (fail closed). `stageCli.ts` verifies Linux output before reporting success and downloads Node 24.14.0 with distribution checksums and a local cache integrity record. Artifact has not been executed on a target Linux machine by this lane; parent remote verifier must still perform actual target smoke.
