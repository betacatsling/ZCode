import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { Emitter } from "@zcode/rpc";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  ZCODE_APP_VERSION_ENV,
  ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV,
  ZCODE_REMOTE_HTTP_PROXY_ENV_KEY,
  ZCODE_REMOTE_NO_PROXY_ENV_KEY,
  ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY,
  ZCODE_VERSION,
} from "@zcode/shared";
import type {
  IRemoteBackend,
  RemoteDisconnectEvent,
  RemoteEnvironment,
  RemotePortForward,
  StdioStream,
} from "./backend.js";
import { connectRemote, pickRemoteRuntimeEnv, type ConnectOptions } from "./connect.js";
import { quotePosixShellArg as q } from "./posixShell.js";

// Characterization of connect.ts (stdio route, persistent SSH route, abort, runtime env) through its
// public API with a fake IRemoteBackend. Written before the pure-move split; must pass unchanged after.

class FakeStream implements StdioStream {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly #close = new Emitter<number>();
  readonly onClose = this.#close.event;
  close(code: number): void {
    this.#close.fire(code);
  }
}

/** A finished command: stdout then exit code, delivered after the caller subscribes. */
function finished(stdout: string, code = 0): FakeStream {
  const stream = new FakeStream();
  setImmediate(() => {
    stream.stdout.write(stdout);
    setImmediate(() => stream.close(code));
  });
  return stream;
}

interface FakeBackendOptions {
  env?: RemoteEnvironment;
  exec: (command: string) => FakeStream;
  exists?: (path: string) => boolean;
  readFile?: (path: string) => string;
  forward?: () => Promise<RemotePortForward>;
  resolveRuntimeProxy?: (proxy: string) => Promise<string>;
}

function fakeBackend(options: FakeBackendOptions) {
  const record = {
    detects: 0,
    execs: [] as string[],
    uploads: [] as [string, string][],
    disposed: 0,
    disposedAndWaited: 0,
  };
  const disconnect = new Emitter<RemoteDisconnectEvent>();
  const backend: IRemoteBackend = {
    async detect() {
      record.detects += 1;
      return options.env ?? { platform: "linux", arch: "x64" };
    },
    async exec(command) {
      record.execs.push(command);
      return options.exec(command);
    },
    async upload(local, remote) {
      record.uploads.push([local, remote]);
    },
    async exists(path) {
      return options.exists?.(path) ?? false;
    },
    async readFile(path) {
      return options.readFile?.(path) ?? "";
    },
    onDidDisconnect: disconnect.event,
    dispose() {
      record.disposed += 1;
    },
    async disposeAndWait() {
      record.disposedAndWaited += 1;
    },
    ...(options.forward ? { openLocalPortForward: options.forward } : {}),
    ...(options.resolveRuntimeProxy ? { resolveRuntimeProxy: options.resolveRuntimeProxy } : {}),
  };
  return { backend, record, disconnect };
}

/** Remote stdio server: answers the handshake once the caller listens. */
function helloServer(): FakeStream {
  const stream = new FakeStream();
  const hello = {
    type: "zcode-hello",
    version: ZCODE_VERSION,
    platform: "linux",
    arch: "x64",
    pid: 7,
  };
  setImmediate(() => stream.stdout.write(`motd banner\n${JSON.stringify(hello)}\n`));
  return stream;
}

const LAUNCH = "~/.zcode/server/node ~/.zcode/server/zcode-server.cjs";
const BASE_ENV = `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote" ZCODE_SERVER_RUNTIME_ROOT="$HOME/.zcode/server"`;

test("pickRemoteRuntimeEnv keeps only allow-listed, non-empty, trimmed keys", () => {
  assert.deepEqual(
    pickRemoteRuntimeEnv({
      ZCODE_ENV: " prod ",
      ZCODE_BASE_URL: "   ",
      ZAI_OAUTH_CLIENT_ID: "client",
      [ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]: "1",
      HOME: "/home/u",
      SECRET_TOKEN: "x",
    }),
    {
      ZCODE_ENV: "prod",
      ZAI_OAUTH_CLIENT_ID: "client",
      [ZCODE_DESKTOP_CONTEXT_PROMPT_ENABLED_ENV]: "1",
    },
  );
});

test("stdio route: exact launch command, handshake ack, close reporting and disposal", async () => {
  const server = helloServer();
  const { backend, record, disconnect } = fakeBackend({
    exec: () => server,
    resolveRuntimeProxy: async () => "http://gateway:3128",
  });
  const closes: number[] = [];
  const connection = await connectRemote(backend, {
    clientId: "client-1",
    skipDeploy: true,
    appVersion: " 1.2.3 ",
    remoteRuntimeEnv: { ZCODE_ENV: "it's", HOME: "/root" },
    remoteRuntimeNetwork: {
      httpProxy: "http://proxy:3128",
      noProxy: "localhost",
      authoritative: true,
    },
    onDidRemoteClose: (event) => closes.push(event.code),
  });
  assert.deepEqual(record.execs, [
    `${BASE_ENV} ZCODE_ENV=${q("it's")} ${ZCODE_APP_VERSION_ENV}=${q("1.2.3")} ` +
      `${ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY}='1' ` +
      `${ZCODE_REMOTE_HTTP_PROXY_ENV_KEY}=${q("http://gateway:3128")} ` +
      `${ZCODE_REMOTE_NO_PROXY_ENV_KEY}=${q("localhost")} ${LAUNCH}`,
  ]);
  const ack = JSON.parse(String(server.stdin.read()).split("\n")[0]!);
  assert.deepEqual(ack, { type: "zcode-hello-ack", version: ZCODE_VERSION, clientId: "client-1" });
  assert.equal(connection.targetId, undefined);

  disconnect.fire({ reason: "close" });
  server.close(3);
  assert.deepEqual(closes, [-1], "backend disconnect reports -1 once; later closes are ignored");
  await connection.disposeAndWait();
  connection.dispose();
  assert.equal(record.disposed, 1, "stream already closed: disposeAndWait disposes synchronously");
  assert.equal(record.disposedAndWaited, 0);
});

test("stdio route: disposeAndWait waits for the stream to close, then awaits the backend", async () => {
  const server = helloServer();
  const { backend, record } = fakeBackend({ exec: () => server });
  const closes: number[] = [];
  const connection = await connectRemote(backend, {
    skipDeploy: true,
    onDidRemoteClose: (event) => closes.push(event.code),
  });
  assert.deepEqual(record.execs, [`${BASE_ENV} ${LAUNCH}`], "no network/env options: base command");
  const waiting = connection.disposeAndWait({ timeoutMs: 5_000 });
  assert.equal(connection.disposeAndWait(), waiting, "in-flight disposeAndWait is shared");
  assert.equal(server.stdin.writableEnded, true, "stdin EOF is sent before any await");
  server.close(0);
  await waiting;
  assert.deepEqual(closes, [0]);
  assert.equal(record.disposedAndWaited, 1);
  assert.equal(record.disposed, 0);
});

test("stdio route: a failed proxy resolution keeps the configured proxy", async () => {
  const { backend, record } = fakeBackend({
    exec: () => helloServer(),
    resolveRuntimeProxy: async () => {
      throw new Error("no gateway");
    },
  });
  const connection = await connectRemote(backend, {
    skipDeploy: true,
    remoteRuntimeNetwork: { httpProxy: "http://proxy:3128", authoritative: true },
  });
  assert.deepEqual(record.execs, [
    `${BASE_ENV} ${ZCODE_REMOTE_RUNTIME_NETWORK_AUTHORITY_ENV_KEY}='1' ` +
      `${ZCODE_REMOTE_HTTP_PROXY_ENV_KEY}=${q("http://proxy:3128")} ${LAUNCH}`,
  ]);
  connection.dispose();
  assert.equal(record.disposed, 1);
});

test("an already-aborted signal disposes the backend before detect", async () => {
  const { backend, record } = fakeBackend({ exec: () => helloServer() });
  const controller = new AbortController();
  controller.abort("user closed the dialog");
  await assert.rejects(connectRemote(backend, { signal: controller.signal }), (error: Error) => {
    assert.equal(error.name, "AbortError");
    assert.equal(error.message, "Remote connection canceled");
    return true;
  });
  assert.equal(record.detects, 0);
  assert.equal(record.disposed, 1);

  const reason = new Error("custom reason");
  const withReason = fakeBackend({ exec: () => helloServer() });
  await assert.rejects(
    connectRemote(withReason.backend, { signal: AbortSignal.abort(reason) }),
    (error) => {
      assert.equal(error, reason, "an Error reason is rethrown as is");
      return true;
    },
  );
  assert.equal(withReason.record.disposed, 1);
});

test("an unsupported (win32) target is refused and the backend disposed once", async () => {
  const { backend, record } = fakeBackend({
    env: { platform: "win32", arch: "x64" },
    exec: () => helloServer(),
  });
  await assert.rejects(connectRemote(backend, { skipDeploy: true }), /POSIX shell/);
  assert.deepEqual(record.execs, []);
  assert.equal(record.disposed, 1);
});

const DATA_ROOT = 'printf "%s" "${ZCODE_DATA_BASE_DIR:-$HOME}"';
const SERVER_ROOT = "/home/u/.zcode/server";

function persistent(
  status: string | undefined,
  extra: Partial<FakeBackendOptions> = {},
  dataRoot = "/home/u",
) {
  return fakeBackend({
    forward: async () => {
      throw new Error("forward must not open");
    },
    exec: (command) => (command === DATA_ROOT ? finished(dataRoot) : finished(status ?? "", 0)),
    ...extra,
  });
}

const SERVE =
  `ZCODE_DATA_BASE_DIR=${q("/home/u")} ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 ` +
  `ZCODE_MULTI_HARNESS_ENABLED=1 ${q(`${SERVER_ROOT}/bin/zcode`)} serve --daemon --json ` +
  `--server-root ${q(SERVER_ROOT)}`;

test("persistent SSH route: data root and installed-runtime checks", async () => {
  const relative = persistent(undefined, {}, "relative/home");
  await assert.rejects(connectRemote(relative.backend), /not an absolute POSIX path/);
  assert.deepEqual(relative.record.execs, [DATA_ROOT]);
  assert.equal(relative.record.disposed, 1);

  const missing = persistent(undefined);
  await assert.rejects(
    connectRemote(missing.backend),
    /No versioned persistent Server runtime is packaged for linux-x64/,
  );
  assert.deepEqual(missing.record.execs, [DATA_ROOT]);
});

test("persistent SSH route: exact serve command and status validation", async () => {
  const installed = { exists: (path: string) => path === `${SERVER_ROOT}/bin/zcode` };
  const cases: [string, RegExp][] = [
    ["not json", /invalid status response/],
    ['{"state":"ready"}', /incomplete status response/],
    [
      '{"state":"ready","host":"0.0.0.0","port":9,"generation":1,"runningTaskCount":0}',
      /did not publish a ready loopback endpoint/,
    ],
    [
      '{"state":"starting","host":"127.0.0.1","port":9,"generation":1,"runningTaskCount":0}',
      /did not publish a ready loopback endpoint/,
    ],
  ];
  for (const [status, expected] of cases) {
    const { backend, record } = persistent(status, installed);
    await assert.rejects(connectRemote(backend), expected);
    assert.deepEqual(record.execs, [DATA_ROOT, SERVE]);
    assert.equal(record.disposed, 1);
  }
  const failed = fakeBackend({
    ...installed,
    forward: async () => assert.fail("no forward"),
    exec: (command) => (command === DATA_ROOT ? finished("/home/u") : finished("", 1)),
  });
  await assert.rejects(connectRemote(failed.backend), /failed to start or attach/);
});

test("persistent SSH route: a failed attach disposes the forward and the backend", async (t) => {
  const http = createServer((_request, response) => response.writeHead(404).end());
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => http.close());
  const port = (http.address() as AddressInfo).port;
  const forwards: string[] = [];
  const ready = {
    state: "ready",
    host: "127.0.0.1",
    port: 4100,
    generation: 1,
    runningTaskCount: 0,
  };
  const { backend, record } = persistent(JSON.stringify(ready), {
    exists: (path) => path === `${SERVER_ROOT}/bin/zcode`,
    forward: async () => ({
      host: "127.0.0.1",
      port,
      dispose: () => forwards.push("dispose"),
      disposeAndWait: async () => void forwards.push("disposeAndWait"),
    }),
  });
  await assert.rejects(connectRemote(backend, {} as ConnectOptions));
  assert.deepEqual(forwards, ["disposeAndWait"]);
  assert.equal(record.disposed, 1);
});

test("persistent SSH route: archive staging, identity conflict and install cleanup", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-connect-archive-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const archivePath = join(dir, "runtime.tar.gz");
  await writeFile(archivePath, "archive-bytes");
  const hash = createHash("sha256").update("archive-bytes").digest("hex");
  const release = `${SERVER_ROOT}/releases/desktop-linux-x64-${hash.slice(0, 24)}`;
  const marker = JSON.stringify({ schemaVersion: 1, target: "linux-x64", sourceHash: hash });
  const options = { persistentTargetRuntimeArchives: { "linux-x64": archivePath } };

  const conflict = persistent(undefined, {
    exists: (path) => path === `${release}/persistent-target-source.json`,
    readFile: () => "other-marker\n",
  });
  await assert.rejects(connectRemote(conflict.backend, options), /identity conflicts/);

  const partial = persistent(undefined, {
    exists: (path) => path === `${release}/runtime/server-cli.js`,
  });
  await assert.rejects(connectRemote(partial.backend, options), /release is incomplete/);

  const remoteArchive = `${SERVER_ROOT}/releases/.runtime-${hash.slice(0, 24)}.tar.gz`;
  const staging = fakeBackend({
    forward: async () => assert.fail("no forward"),
    exec: (command) => (command === DATA_ROOT ? finished("/home/u") : finished("", 1)),
  });
  await assert.rejects(connectRemote(staging.backend, options), /Could not stage/);
  assert.deepEqual(staging.record.uploads, [[archivePath, remoteArchive]]);
  const [, install, cleanup] = staging.record.execs;
  const stagingDir = /mkdir -p \S+ '([^']+)'/.exec(install!)![1]!;
  assert.match(stagingDir, /^\/home\/u\/\.zcode\/server\/releases\/\.staging-[0-9a-f-]{36}$/);
  const staged = `${stagingDir}/zcode-server-linux-x64`;
  assert.equal(
    install,
    [
      "set -eu",
      `mkdir -p ${q(`${SERVER_ROOT}/releases`)} ${q(stagingDir)}`,
      `tar -xf ${q(remoteArchive)} -C ${q(stagingDir)}`,
      `test -f ${q(`${staged}/runtime/server-cli.js`)}`,
      `test -f ${q(`${staged}/runtime/server-core.js`)}`,
      `mv ${q(staged)} ${q(release)}`,
      `printf '%s\\n' ${q(marker)} > ${q(`${release}/persistent-target-source.json`)}`,
      `rm -rf ${q(stagingDir)}`,
      `rm -f ${q(remoteArchive)}`,
    ].join(" && "),
  );
  assert.equal(cleanup, `rm -rf ${q(stagingDir)} && rm -f ${q(remoteArchive)}`);
  assert.equal(staging.record.execs.length, 3);
});
