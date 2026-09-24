import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { zcodeProtocolMethods } from '@zcode/shared';
import { V4_METHODS } from '@zcode/shared/zcode-protocol-v4';

if (process.env.ZCODE_NATIVE_CONTROL_TEST_CHILD === '1') {
  // Disposable worker uses the real protocol server and real CommandInbox; no DB, daemon or provider.
  const { ZCodeProtocolAgentServer } = await import('./server.js');
  const server = new ZCodeProtocolAgentServer({ createZCodeApp: () => { throw new Error('test must not start agent'); } });
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    const response = await server.handleMessage(message);
    process.stdout.write(JSON.stringify(response) + '\n');
  }
  await server.shutdown();
  server.disposeProjections();
} else {
  test('real child stdio reaches live worker fence; fresh create cannot pass, stale lease cannot release', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', new URL(import.meta.url).pathname], {
      env: { ...process.env, ZCODE_NATIVE_CONTROL_TEST_CHILD: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    let seq = 0;
    async function request(method: string, params: unknown) {
      const id = ++seq;
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      const line = await lines.next();
      assert.equal(line.done, false);
      const response = JSON.parse(line.value);
      assert.equal(response.id, id);
      return response;
    }
    try {
      const frozen = await request(zcodeProtocolMethods.nativeMaintenanceFreeze, {});
      assert.equal(frozen.result.activity.frozen, true);
      assert.equal(frozen.result.activity.unknown, false);
      const create = await request(V4_METHODS.command, {
        commandId: 'fresh', clientId: 'client', sessionId: null,
        type: 'createSession', payload: { workspaceId: 'test' }, issuedAt: Date.now(),
      });
      // A valid new command must reject at owner, never call the fake app constructor.
      assert.equal(create.result.reasonCode, 'guard.nativeMaintenanceFrozen');
      const stale = await request(zcodeProtocolMethods.nativeMaintenanceRelease, {
        ...frozen.result.lease, leaseId: '00000000-0000-4000-8000-000000000000',
      });
      assert.ok(stale.error);
      const activity = await request(zcodeProtocolMethods.nativeMaintenanceGetActivity, frozen.result.lease);
      assert.equal(activity.result.frozen, true);
      const released = await request(zcodeProtocolMethods.nativeMaintenanceRelease, frozen.result.lease);
      assert.equal(released.result.released, true);
    } finally {
      child.stdin.end();
      await new Promise<void>((resolve, reject) => {
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`)));
        child.once('error', reject);
      });
    }
  });
}
