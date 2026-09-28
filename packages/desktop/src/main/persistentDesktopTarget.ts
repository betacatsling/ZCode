import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  currentServerTarget,
  resolveServerLayout,
  serverStatusSchema,
} from "@zcode/server-cli/target";
import { getDataBaseDir } from "@zcode/services/node";
import { pickRemoteRuntimeEnv } from "@zcode/server/remote";

const TARGET_RUNTIME_SCHEMA_VERSION = 1;

export interface DesktopPersistentTargetEndpoint {
  host: string;
  port: number;
  targetId: string;
  runtimeArchives: Record<string, string>;
}

export interface DesktopPersistentTargetReady extends DesktopPersistentTargetEndpoint {
  generation: number;
  sourceHash: string;
}

export interface DesktopPersistentTargetManagerOptions {
  targetId: string;
  resourcesDirectory: string;
  dataBaseDir?: string;
  target?: string;
  environment?: Record<string, string | undefined>;
  skipServiceRegistration?: boolean;
}

interface RuntimeSourceMarker {
  schemaVersion: typeof TARGET_RUNTIME_SCHEMA_VERSION;
  target: string;
  sourceHash: string;
}

function isLoopbackHost(host: string): boolean {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function buildTargetEnvironment(
  source: Record<string, string | undefined>,
  dataBaseDir: string,
  serverRoot: string,
  skipServiceRegistration: boolean,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...pickRemoteRuntimeEnv(source),
    ZCODE_DATA_BASE_DIR: dataBaseDir,
    ZCODE_SERVER_ROOT: serverRoot,
    // P4 moves the already-authorized Pi worker behind the target Supervisor.
    ZCODE_MULTI_HARNESS_ENABLED: "1",
  };
  for (const key of [
    "ZCODE_GIT_BINARY",
    "ZCODE_PERSONAL_PROVIDER_CONFIG_FILE",
    "NODE_EXTRA_CA_CERTS",
  ]) {
    const value = source[key]?.trim();
    if (value) environment[key] = value;
  }
  if (skipServiceRegistration || source.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION === "1") {
    environment.ZCODE_SERVER_SKIP_SERVICE_REGISTRATION = "1";
  }
  return environment;
}

function extractArchive(archivePath: string, destination: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Windows 10+, macOS and Linux provide `tar`; the server release packager
    // writes tar.gz for POSIX targets and zip for Windows targets.
    const child = spawn("tar", ["-xf", archivePath, "-C", destination], {
      stdio: "ignore",
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    });
    child.once("error", () =>
      rejectPromise(new Error("Could not extract persistent target runtime")),
    );
    child.once("exit", (code) => {
      if (code === 0) resolvePromise();
      else
        rejectPromise(new Error(`Persistent target runtime extraction failed (${code ?? "null"})`));
    });
  });
}

async function ensureVersionedRuntime(options: {
  target: string;
  archivePath: string;
  serverRoot: string;
}): Promise<{ runtimeDir: string; sourceHash: string }> {
  const archiveBytes = await readFile(options.archivePath);
  const sourceHash = createHash("sha256").update(archiveBytes).digest("hex");
  const releaseBase = join(options.serverRoot, "releases");
  const releaseDir = join(releaseBase, `${options.target}-${sourceHash.slice(0, 24)}`);
  const markerPath = join(releaseDir, "persistent-target-source.json");
  if (await pathExists(releaseDir)) {
    let marker: RuntimeSourceMarker;
    try {
      marker = JSON.parse(await readFile(markerPath, "utf8")) as RuntimeSourceMarker;
    } catch {
      throw new Error("Persistent target runtime version directory is incomplete");
    }
    if (
      marker.schemaVersion !== TARGET_RUNTIME_SCHEMA_VERSION ||
      marker.target !== options.target ||
      marker.sourceHash !== sourceHash
    ) {
      throw new Error(
        "Persistent target runtime version directory has a conflicting source marker",
      );
    }
    return { runtimeDir: join(releaseDir, "runtime"), sourceHash };
  }

  await mkdir(releaseBase, { recursive: true, mode: 0o700 });
  const stagingDir = await mkdtemp(join(releaseBase, `.staging-${randomUUID()}-`));
  try {
    await extractArchive(options.archivePath, stagingDir);
    const stagedRelease = join(stagingDir, `zcode-server-${options.target}`);
    const runtimeDir = join(stagedRelease, "runtime");
    const runtimeNode = join(runtimeDir, options.target.startsWith("win32-") ? "node.exe" : "node");
    for (const path of [
      runtimeNode,
      join(runtimeDir, "server-cli.js"),
      join(runtimeDir, "server-core.js"),
      join(runtimeDir, "piWorker.js"),
      join(runtimeDir, "zcode.cjs"),
    ]) {
      if (!(await pathExists(path)))
        throw new Error("Persistent target runtime is missing a required entrypoint");
    }
    const marker: RuntimeSourceMarker = {
      schemaVersion: TARGET_RUNTIME_SCHEMA_VERSION,
      target: options.target,
      sourceHash,
    };
    await writeFile(
      join(stagedRelease, "persistent-target-source.json"),
      `${JSON.stringify(marker)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    try {
      await rename(stagedRelease, releaseDir);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      // Another Desktop process staged the same immutable release first. It is
      // safe to share only after the published source marker matches this hash.
      const markerOnDisk = JSON.parse(await readFile(markerPath, "utf8")) as RuntimeSourceMarker;
      if (markerOnDisk.sourceHash !== sourceHash) throw error;
    }
    return { runtimeDir: join(releaseDir, "runtime"), sourceHash };
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function runServerCli(options: {
  runtimeDir: string;
  serverRoot: string;
  dataBaseDir: string;
  targetId: string;
  environment: Record<string, string | undefined>;
  skipServiceRegistration: boolean;
}): Promise<DesktopPersistentTargetReady> {
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nodePath = join(options.runtimeDir, nodeName);
  const cliPath = join(options.runtimeDir, "server-cli.js");
  const environment = buildTargetEnvironment(
    options.environment,
    options.dataBaseDir,
    options.serverRoot,
    options.skipServiceRegistration,
  );
  const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(
      nodePath,
      [
        cliPath,
        "serve",
        "--daemon",
        "--server-root",
        options.serverRoot,
        "--target-id",
        options.targetId,
        "--json",
      ],
      { cwd: options.serverRoot, env: environment, stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 1024 * 1024) child.kill();
    });
    child.once("error", () =>
      rejectPromise(new Error("Could not launch persistent target Supervisor")),
    );
    child.once("exit", (code) => {
      if (code === 0 && output.length <= 1024 * 1024) resolvePromise(output);
      else
        rejectPromise(new Error(`Persistent target Supervisor launch failed (${code ?? "null"})`));
    });
  });
  let status: ReturnType<typeof serverStatusSchema.parse>;
  try {
    status = serverStatusSchema.parse(JSON.parse(stdout.trim()));
  } catch {
    throw new Error("Persistent target Supervisor returned an invalid status");
  }
  if (
    status.state !== "ready" ||
    !status.host ||
    status.port === null ||
    status.port < 1 ||
    !isLoopbackHost(status.host)
  ) {
    throw new Error("Persistent target Supervisor did not publish a ready loopback endpoint");
  }
  return {
    host: status.host,
    port: status.port,
    targetId: options.targetId,
    generation: status.generation,
    sourceHash: "",
  };
}

export function createPersistentDesktopTargetManager(
  options: DesktopPersistentTargetManagerOptions,
): { ensure(): Promise<DesktopPersistentTargetReady> } {
  const target = options.target ?? currentServerTarget();
  const dataBaseDir = resolve(options.dataBaseDir ?? getDataBaseDir());
  const serverRoot = resolveServerLayout(join(dataBaseDir, ".zcode", "server")).serverRoot;
  const environment = options.environment ?? process.env;
  let ensureInFlight: Promise<DesktopPersistentTargetReady> | undefined;
  return {
    ensure() {
      if (ensureInFlight) return ensureInFlight;
      ensureInFlight = (async () => {
        const extension = target.startsWith("win32-") ? "zip" : "tar.gz";
        const archivePath = join(options.resourcesDirectory, `${target}.${extension}`);
        if (!(await pathExists(archivePath))) {
          throw new Error("Persistent target runtime archive is missing from Desktop resources");
        }
        const { runtimeDir, sourceHash } = await ensureVersionedRuntime({
          target,
          archivePath,
          serverRoot,
        });
        await mkdir(serverRoot, { recursive: true, mode: 0o700 });
        const ready = await runServerCli({
          runtimeDir,
          serverRoot,
          dataBaseDir,
          targetId: options.targetId,
          environment,
          skipServiceRegistration: options.skipServiceRegistration === true,
        });
        const runtimeArchives: Record<string, string> = {};
        for (const candidate of new Set([target, "linux-x64"])) {
          const candidateExtension = candidate.startsWith("win32-") ? "zip" : "tar.gz";
          const candidatePath = join(
            options.resourcesDirectory,
            `${candidate}.${candidateExtension}`,
          );
          if (await pathExists(candidatePath)) runtimeArchives[candidate] = candidatePath;
        }
        return { ...ready, sourceHash, runtimeArchives };
      })().catch((error: unknown) => {
        ensureInFlight = undefined;
        throw error;
      });
      return ensureInFlight;
    },
  };
}

export function resolveDesktopPersistentTargetResourcesPath(options: {
  isPackaged: boolean;
  resourcesPath: string;
  desktopPackageRoot: string;
}): string {
  return options.isPackaged
    ? join(options.resourcesPath, "persistent-target")
    : resolve(options.desktopPackageRoot, "resources/persistent-target");
}
