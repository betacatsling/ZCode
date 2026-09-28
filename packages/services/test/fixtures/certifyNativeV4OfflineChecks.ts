import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  isNativeCheckCommand,
  prepareNativeFetchGuard,
  readNativeFetchAudit,
  nativeRepoRoot,
} from "./certifyNativeV4Common.js";
import {
  cleanupNativeFixtureChild,
  spawnNativeFixtureChild,
  type FixtureChild,
} from "./certifyNativeV4FakeProcess.js";

function verifyCheckCommandParser(): void {
  const workspace = "/tmp/native fixture parser";
  const accepted = [
    "node check.mjs",
    "node ./check.mjs",
    `node ${workspace}/check.mjs`,
    `node "${workspace}/check.mjs"`,
    `cd '${workspace}' && node check.mjs`,
    `cd "${workspace}" && node ./check.mjs`,
  ];
  const rejected = [
    "echo node check.mjs",
    "node check.mjs extra",
    "node check.mjs && touch marker",
    "node check.mjs; true",
    "node -e 'process.exit(0)'",
    "NODE_ENV=test node check.mjs",
  ];
  for (const command of accepted)
    assert.equal(isNativeCheckCommand(command, workspace), true, command);
  for (const command of rejected)
    assert.equal(isNativeCheckCommand(command, workspace), false, command);
}

async function verifyCapturedFailure(path: string | undefined): Promise<void> {
  if (!path) return;
  const firstLine = (await readFile(path, "utf8")).split("\n", 1)[0];
  assert.ok(firstLine, "captured safe failure log is empty");
  const evidence = JSON.parse(firstLine) as {
    status?: string;
    error?: string;
  };
  assert.equal(evidence.status, "native-v4-live-failed");
  assert.equal(evidence.error, "model must run node check.mjs");
  assert.notEqual(evidence.status, "native-v4-live-pass");
}

async function verifyFetchGuard(root: string): Promise<void> {
  const executionSource = await readFile(
    join(nativeRepoRoot, "apps/zcode-cli/packages/adapters/src/model/model-execution.ts"),
    "utf8",
  );
  const networkSource = await readFile(
    join(nativeRepoRoot, "apps/zcode-cli/packages/adapters/src/network/proxy-fetch.ts"),
    "utf8",
  );
  assert.ok(executionSource.includes('case "anthropic":'));
  assert.ok(executionSource.includes("fetch: createAnthropicCompatFetch(optionFetch)"));
  assert.ok(executionSource.includes('case "openai-compatible":'));
  assert.ok(executionSource.includes("fetch: optionFetch"));
  assert.ok(networkSource.includes("globalThis.fetch.bind(globalThis)"));

  const probeRoot = join(root, "fetch-guard-offline-probe");
  await mkdir(probeRoot, { recursive: true, mode: 0o700 });
  const paths: string[] = [];
  const server = createServer((request, response) => {
    paths.push(request.url ?? "");
    if (request.url === "/v1/messages/cancel") return;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const endpoint = `http://127.0.0.1:${address.port}`;
  const guard = await prepareNativeFetchGuard(probeRoot, 3, endpoint);
  const childSource = [
    `const endpoint = ${JSON.stringify(endpoint)};`,
    'const init = { method: "POST", headers: { "content-type": "application/json" }, body: "{}" };',
    'for (const path of ["/v1/chat/completions", "/v1/messages"]) {',
    "  const response = await fetch(new URL(path, endpoint), init);",
    "  if (!response.ok) throw new Error(`unexpected response ${response.status}`);",
    "  await response.text();",
    "}",
    "const controller = new AbortController();",
    'const cancelled = fetch(new URL("/v1/messages/cancel", endpoint), { ...init, signal: controller.signal });',
    "setTimeout(() => controller.abort(), 20);",
    'try { await cancelled; throw new Error("expected the synthetic request to be cancelled"); }',
    'catch (error) { if (error?.message === "expected the synthetic request to be cancelled") throw error; }',
    'try { await fetch(new URL("/v1/messages/blocked", endpoint), init); throw new Error("expected the guard to block the fourth send"); }',
    'catch (error) { if (!String(error).includes("guard blocked")) throw error; }',
    'try { await fetch("http://provider.invalid/v1/messages", init); throw new Error("expected the fake origin guard to block the fifth send"); }',
    'catch (error) { if (!String(error).includes("non-fixture origin")) throw error; }',
  ].join("\n");
  let ownedChild: FixtureChild | undefined;
  try {
    ownedChild = spawnNativeFixtureChild(
      process.execPath,
      ["--input-type=module", "--eval", childSource],
      {
        env: {
          PATH: process.env.PATH ?? process.env.Path ?? "",
          ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
          ...(process.env.WINDIR ? { WINDIR: process.env.WINDIR } : {}),
          NODE_OPTIONS: guard.nodeOptions,
        },
      },
    );
    const child = ownedChild.process;
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr = `${stderr}${chunk}`.slice(-2_000);
    });
    const closeResult = await ownedChild.close;
    assert.equal(closeResult.exitCode, 0, stderr);
    assert.equal(closeResult.signal, null, stderr);
    assert.deepEqual(paths, ["/v1/chat/completions", "/v1/messages", "/v1/messages/cancel"]);
    const audit = await readNativeFetchAudit(guard.auditPath);
    assert.deepEqual(audit, {
      logicalFetchAttempts: 5,
      nativeFetchInvocations: 3,
      httpResponses: 2,
      httpErrorResponses: 0,
      fetchFailures: 0,
      cancelledFetches: 1,
      blockedBeforeSend: 2,
      unknownOutcomes: 0,
      routeAttempts: { titleSidecar: 0, providerModel: 3, auxiliary: 2, unknown: 0 },
    });
    console.log(
      JSON.stringify({
        status: "native-v4-fetch-guard-offline-pass",
        adapterCoverage: ["openai-compatible", "anthropic-messages"],
        spawnPid: ownedChild.pid,
        cleanupExitCode: closeResult.exitCode,
        cleanupSignal: closeResult.signal,
        gatewayPaths: paths,
        audit,
        cancellationAuditFlushed: true,
      }),
    );
  } finally {
    if (ownedChild) {
      const cleanup = await cleanupNativeFixtureChild(ownedChild, undefined);
      assert.equal(cleanup.normal, true, JSON.stringify(cleanup));
      console.log(
        JSON.stringify({
          event: "native-v4-fetch-guard-child-cleanup",
          spawnPid: ownedChild.pid,
          cleanup,
        }),
      );
    }
    server.closeAllConnections();
    await new Promise<void>((resolvePromise, rejectPromise) =>
      server.close((error) => (error ? rejectPromise(error) : resolvePromise())),
    );
  }
}

export async function runNativeV4OfflineChecks(root: string): Promise<void> {
  verifyCheckCommandParser();
  await verifyCapturedFailure(process.env.CERTIFY_NATIVE_PRIOR_SAFE_LOG?.trim());
  await verifyFetchGuard(root);
  console.log(
    JSON.stringify({
      status: "native-v4-offline-assertions-pass",
      commandParser: "synthetic-exact-variants",
      capturedPreviousFailure: Boolean(process.env.CERTIFY_NATIVE_PRIOR_SAFE_LOG?.trim()),
    }),
  );
}
