// Persistent SSH route: versioned runtime staging, daemon attach and loopback forward (moved from connect.ts).
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import type { IRemoteBackend, RemoteEnvironment, RemotePortForward } from "./backend.js";
import { quotePosixShellArg } from "./posixShell.js";
import { connectToPersistentTarget } from "./persistentTargetClient.js";
import {
  BACKEND_DISCONNECT_EXIT_CODE,
  throwIfRemoteConnectAborted,
  type ConnectOptions,
  type RemoteConnection,
} from "./connectShared.js";

interface RemotePersistentTargetStatus {
  state: string;
  host: string | null;
  port: number | null;
  generation: number;
  runningTaskCount: number;
  hostBootstrapToken?: unknown; // private secret, delivered over the SSH exec channel
}

async function runRemoteCommand(
  backend: IRemoteBackend,
  command: string,
): Promise<{ code: number; stdout: string }> {
  const stream = await backend.exec(command);
  return await new Promise((resolvePromise, rejectPromise) => {
    let stdout = "";
    let outputTooLarge = false;
    stream.stdout.on("data", (chunk: Buffer | string) => {
      if (outputTooLarge) return;
      stdout += chunk.toString();
      if (stdout.length > 1024 * 1024) outputTooLarge = true;
    });
    stream.onClose((code) => {
      if (outputTooLarge) {
        rejectPromise(new Error("Remote Server command output exceeded its limit"));
      } else {
        resolvePromise({ code, stdout });
      }
    });
  });
}

function parseRemotePersistentTargetStatus(raw: string): RemotePersistentTargetStatus {
  let value: unknown;
  try {
    value = JSON.parse(raw.trim());
  } catch {
    throw new Error("Remote Server returned an invalid status response");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("state" in value) ||
    typeof value.state !== "string" ||
    !("host" in value) ||
    (value.host !== null && typeof value.host !== "string") ||
    !("port" in value) ||
    (value.port !== null && typeof value.port !== "number") ||
    !("generation" in value) ||
    typeof value.generation !== "number" ||
    !("runningTaskCount" in value) ||
    typeof value.runningTaskCount !== "number"
  ) {
    throw new Error("Remote Server returned an incomplete status response");
  }
  return value as RemotePersistentTargetStatus;
}

export async function connectPersistentSSH(
  backend: IRemoteBackend,
  env: RemoteEnvironment,
  options?: ConnectOptions,
): Promise<RemoteConnection> {
  const targetKey = `${env.platform}-${env.arch}`;
  const archivePath = options?.persistentTargetRuntimeArchives?.[targetKey];
  const dataBaseCommand = 'printf "%s" "${ZCODE_DATA_BASE_DIR:-$HOME}"';
  const dataBaseResult = await runRemoteCommand(backend, dataBaseCommand);
  if (dataBaseResult.code !== 0) {
    throw new Error("Could not resolve the remote target data root");
  }
  const dataBaseDir = dataBaseResult.stdout.trim();
  if (!dataBaseDir.startsWith("/")) {
    throw new Error("Remote target data root is not an absolute POSIX path");
  }
  const serverRoot = posix.join(dataBaseDir, ".zcode", "server");
  let runtimeNode: string | undefined;
  let runtimeCli: string | undefined;
  let sourceHash: string | undefined;

  if (archivePath) {
    const archiveBytes = await readFile(archivePath);
    sourceHash = createHash("sha256").update(archiveBytes).digest("hex");
    const releaseName = `desktop-${targetKey}-${sourceHash.slice(0, 24)}`;
    const releaseDir = posix.join(serverRoot, "releases", releaseName);
    const runtimeDir = posix.join(releaseDir, "runtime");
    const markerPath = posix.join(releaseDir, "persistent-target-source.json");
    const marker = JSON.stringify({ schemaVersion: 1, target: targetKey, sourceHash });
    if (await backend.exists(markerPath)) {
      const installedMarker = await backend.readFile(markerPath);
      if (installedMarker.trim() !== marker) {
        throw new Error("Remote target runtime identity conflicts with its versioned release");
      }
    } else {
      if (await backend.exists(posix.join(runtimeDir, "server-cli.js"))) {
        throw new Error("Remote target runtime release is incomplete; refusing to overwrite it");
      }
      const extension = targetKey.startsWith("win32-") ? "zip" : "tar.gz";
      const remoteArchive = posix.join(
        serverRoot,
        "releases",
        `.runtime-${sourceHash.slice(0, 24)}.${extension}`,
      );
      const stagingDir = posix.join(serverRoot, "releases", `.staging-${randomUUID()}`);
      const stagedReleaseDir = posix.join(stagingDir, `zcode-server-${targetKey}`);
      await backend.upload(archivePath, remoteArchive, { signal: options?.signal });
      const installScript = [
        "set -eu",
        `mkdir -p ${quotePosixShellArg(posix.dirname(remoteArchive))} ${quotePosixShellArg(stagingDir)}`,
        `tar -xf ${quotePosixShellArg(remoteArchive)} -C ${quotePosixShellArg(stagingDir)}`,
        `test -f ${quotePosixShellArg(posix.join(stagedReleaseDir, "runtime", "server-cli.js"))}`,
        `test -f ${quotePosixShellArg(posix.join(stagedReleaseDir, "runtime", "server-core.js"))}`,
        `mv ${quotePosixShellArg(stagedReleaseDir)} ${quotePosixShellArg(releaseDir)}`,
        `printf '%s\\n' ${quotePosixShellArg(marker)} > ${quotePosixShellArg(markerPath)}`,
        `rm -rf ${quotePosixShellArg(stagingDir)}`,
        `rm -f ${quotePosixShellArg(remoteArchive)}`,
      ].join(" && ");
      const installed = await runRemoteCommand(backend, installScript);
      if (installed.code !== 0) {
        const cleanup = [
          `rm -rf ${quotePosixShellArg(stagingDir)}`,
          `rm -f ${quotePosixShellArg(remoteArchive)}`,
        ].join(" && ");
        await runRemoteCommand(backend, cleanup).catch(() => undefined);
        throw new Error("Could not stage the remote persistent target runtime");
      }
    }
    runtimeNode = posix.join(runtimeDir, "node");
    runtimeCli = posix.join(runtimeDir, "server-cli.js");
  } else {
    const installedCli = posix.join(serverRoot, "bin", "zcode");
    if (!(await backend.exists(installedCli))) {
      throw new Error(`No versioned persistent Server runtime is packaged for ${targetKey}`);
    }
    runtimeCli = installedCli;
  }

  const targetCommand = runtimeNode
    ? `${quotePosixShellArg(runtimeNode)} ${quotePosixShellArg(runtimeCli!)}`
    : quotePosixShellArg(runtimeCli!);
  const serveCommand = [
    `ZCODE_DATA_BASE_DIR=${quotePosixShellArg(dataBaseDir)}`,
    "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1",
    "ZCODE_MULTI_HARNESS_ENABLED=1",
    targetCommand,
    "serve --daemon --json --server-root",
    quotePosixShellArg(serverRoot),
  ].join(" ");
  throwIfRemoteConnectAborted(options?.signal);
  const statusResult = await runRemoteCommand(backend, serveCommand);
  if (statusResult.code !== 0) {
    throw new Error("Remote persistent Server failed to start or attach");
  }
  const status = parseRemotePersistentTargetStatus(statusResult.stdout);
  if (
    status.state !== "ready" ||
    status.host !== "127.0.0.1" ||
    status.port === null ||
    status.port < 1
  ) {
    throw new Error("Remote persistent Server did not publish a ready loopback endpoint");
  }
  throwIfRemoteConnectAborted(options?.signal);
  const forward: RemotePortForward = await backend.openLocalPortForward!(status.port);
  let reportedClose = false;
  const reportRemoteClose = (code: number) => {
    if (reportedClose) return;
    reportedClose = true;
    options?.onDidRemoteClose?.({ code });
  };
  const disconnectDisposable = backend.onDidDisconnect?.(() =>
    reportRemoteClose(BACKEND_DISCONNECT_EXIT_CODE),
  );
  let connection: Awaited<ReturnType<typeof connectToPersistentTarget>>;
  try {
    connection = await connectToPersistentTarget({
      host: forward.host,
      port: forward.port,
      ...(typeof status.hostBootstrapToken === "string" && {
        hostBootstrapToken: status.hostBootstrapToken,
      }),
      signal: options?.signal,
      onDidClose: () => reportRemoteClose(BACKEND_DISCONNECT_EXIT_CODE),
    });
  } catch (error) {
    disconnectDisposable?.dispose();
    await forward.disposeAndWait();
    throw error;
  }

  let disposed = false;
  let disposeAndWaitInFlight: Promise<void> | undefined;
  return {
    services: connection.services,
    client: connection.client,
    targetId: connection.targetId,
    dispose() {
      if (disposed) return;
      disposed = true;
      disconnectDisposable?.dispose();
      connection.dispose();
      forward.dispose();
      backend.dispose();
    },
    disposeAndWait() {
      if (disposeAndWaitInFlight) return disposeAndWaitInFlight;
      if (disposed) return Promise.resolve();
      disposed = true;
      disconnectDisposable?.dispose();
      disposeAndWaitInFlight = (async () => {
        await connection.disposeAndWait();
        await forward.disposeAndWait();
        if (backend.disposeAndWait) await backend.disposeAndWait();
        else backend.dispose();
      })();
      return disposeAndWaitInFlight;
    },
  };
}
