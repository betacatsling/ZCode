import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ZCODE_VERSION } from "@zcode/shared";
import { invokeUserOwnedServer, type PackagedTargetServer } from "./targetServerProcess.js";

/** Main transports identity and location only; no mutable task/session truth lives in this record. */
export interface LocalCoreEndpoint {
  readonly endpoint: string;
  readonly installationId: string;
  readonly version: string;
  readonly generation: number;
}

/** Resolves an owned, packaged CLI; never falls back to a source-tree or a window executor. */
export interface LocalCoreAttachmentSource {
  resolvePackagedServer(): Promise<PackagedTargetServer>;
  prepare(server: PackagedTargetServer): Promise<LocalCoreEndpoint>;
}

/** Neither a stale renderer callback nor its late Core status may become a new window attachment. */
export async function prepareWindowLocalCore(
  prepare: () => Promise<LocalCoreEndpoint>,
  isCurrent: () => boolean,
): Promise<LocalCoreEndpoint | undefined> {
  if (!isCurrent()) return undefined;
  const endpoint = await prepare();
  return isCurrent() ? endpoint : undefined;
}

interface ReadyStatus {
  state: "ready";
  host: string;
  port: number;
  version: string;
  generation: number;
}

function assertReadyStatus(raw: unknown): asserts raw is ReadyStatus {
  if (
    !raw ||
    typeof raw !== "object" ||
    !("state" in raw && raw.state === "ready") ||
    !("host" in raw && raw.host === "127.0.0.1") ||
    !(
      "port" in raw &&
      Number.isInteger(raw.port) &&
      typeof raw.port === "number" &&
      raw.port > 0 &&
      raw.port <= 65535
    ) ||
    !("version" in raw && raw.version === ZCODE_VERSION) ||
    !(
      "generation" in raw &&
      typeof raw.generation === "number" &&
      Number.isInteger(raw.generation) &&
      raw.generation > 0
    )
  )
    throw new Error("Local Core status/loopback/version unavailable");
}

/** Owned root marker is the identity authority; an HTTP self-report cannot establish it. */
export async function prepareLocalCoreAttachment(
  server: PackagedTargetServer,
): Promise<LocalCoreEndpoint> {
  const served = await invokeUserOwnedServer(server, "serve");
  assertReadyStatus(served);
  const status = await invokeUserOwnedServer(server, "status");
  assertReadyStatus(status);
  if (served.generation !== status.generation)
    throw new Error("Core generation changed while attaching");
  const root = await realpath(server.serverRoot);
  const marker = join(root, "install.json");
  if (!(await stat(marker)).isFile() || (await realpath(marker)) !== marker) {
    throw new Error("Core installation marker is not a regular owned file");
  }
  const identity: unknown = JSON.parse(await readFile(marker, "utf8"));
  if (
    !identity ||
    typeof identity !== "object" ||
    !("product" in identity && identity.product === "zcode-server") ||
    !("schemaVersion" in identity && identity.schemaVersion === 1) ||
    !("canonicalServerRoot" in identity && identity.canonicalServerRoot === root) ||
    !(
      "installationId" in identity &&
      typeof identity.installationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        identity.installationId,
      )
    )
  )
    throw new Error("Core installation identity unavailable");
  return {
    endpoint: `http://${status.host}:${status.port}`,
    installationId: identity.installationId,
    version: status.version,
    generation: status.generation,
  };
}

/** Explicit runtime path only: never silently select source CLI or user's global Node. */
export function packagedLocalCoreServer(
  resourcesPath: string,
  serverRoot: string,
): PackagedTargetServer {
  const runtime = resolve(resourcesPath, "zcode-server", "runtime");
  return {
    node: join(runtime, process.platform === "win32" ? "node.exe" : "node"),
    cli: join(runtime, "server-cli.js"),
    serverRoot,
  };
}
