/**
 * Child-process scenario for providerErrorStderrRedaction.test.ts: one failing Pi turn against the
 * loopback fake Provider (HTTP status from argv) through the real AiSdkModelAdapter. The parent
 * captures this process's whole stderr, so nothing that writes to fd 2 can escape the assertion.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderFailureHost, startFailingProvider } from "./providerFailureHost.js";

const SCENARIO_RESULT_PREFIX = "STDERR-SCENARIO-RESULT ";

const status = Number(process.argv[2]);
if (!Number.isInteger(status)) throw new Error("usage: providerErrorStderrScenario <status>");

const root = await mkdtemp(join(tmpdir(), "zcode-stderr-redaction-"));
const provider = await startFailingProvider();
const host = await createProviderFailureHost(root, provider.origin, {
  maxAttempts: 2,
  baseDelayMs: 0,
  maxDelayMs: 0,
  jitter: false,
});
try {
  const spec = host.specFor(`stderr-${status}`);
  await host.target.create(spec);
  provider.state.failWith = status;
  await host.target.dispatch(spec, {
    type: "send",
    commandId: "turn-1-command",
    hostSessionId: spec.hostSessionId,
    turnId: "turn-1",
    text: "fail please",
  });
  await host.target.waitForIdle(spec);
  const snapshot = await host.target.snapshot(spec);
  process.stdout.write(
    `${SCENARIO_RESULT_PREFIX}${JSON.stringify({
      providerId: host.providerId,
      requests: provider.state.requests,
      lastErrorCode: snapshot.control.lastError?.code,
    })}\n`,
  );
} finally {
  await host.dispose();
  await provider.close();
  await rm(root, { recursive: true, force: true });
}
