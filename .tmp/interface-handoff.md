# ssh-package API (early)

Owner: SSH backend supplies temporary transport; installed Core supplies durable runtime.
- `stageRelease({ target: 'linux-x64' | 'linux-arm64', nodeBinaryPath, distDir, agentBundlePath, ... }): Promise<{releaseDir,archivePath,componentArchivePaths,packagedDependencies}>` (existing API, strengthened closure checks). `manifest.json` pins `nodeVersion: '24.14.0'`; release includes `bin/zcode`, `runtime/{node,server-cli.js,server-core.js,piWorker.js,zcode.cjs,node_modules}`.
- Target bootstrap/attachment must use existing SSH backend and loopback ticket handshake, fail closed on identity/version. Not an SSH-owned Host or daemon.
- SHA: to be published with interface commit below.
