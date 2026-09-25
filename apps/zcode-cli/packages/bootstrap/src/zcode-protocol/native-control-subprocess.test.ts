import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { zcodeProtocolMethods } from '@zcode/shared';
import { V4_METHODS } from '@zcode/shared/zcode-protocol-v4';

if (process.env.ZCODE_NATIVE_CONTROL_TEST_CHILD === '1') {
  // Disposable worker uses the real protocol server and real CommandInbox; no DB, daemon or provider.
  const { ZCodeProtocolAgentServer } = await import('./server.js');
  let unblock!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const server = new ZCodeProtocolAgentServer({
    createZCodeApp: () => { throw new Error('test must not start agent'); },
    syncAccountProviderConfig: async snapshot => {
      process.stdout.write(JSON.stringify({ id: 'test/entered', revision: snapshot.revision }) + '\n');
      await gate;
      if (process.env.ZCODE_NATIVE_TEST_MARKER) await writeFile(process.env.ZCODE_NATIVE_TEST_MARKER, snapshot.revision);
      return true;
    },
  });
  const active = new Set<Promise<void>>();
  for await (const line of createInterface({ input: process.stdin })) {
    const message = JSON.parse(line);
    if (message.method === 'test/unblock') { unblock(); continue; }
    const work = server.handleMessage(message).then(response => {
      process.stdout.write(JSON.stringify(response) + '\n');
    });
    active.add(work);
    void work.finally(() => active.delete(work));
  }
  await Promise.all(active);
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
  test('subprocess durable provider write drains under held freeze and terminated lease cannot release a new worker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'zcode-native-fence-'));
    const marker = join(directory, 'config-committed');
    const spawnWorker = () => spawn(process.execPath, ['--import', 'tsx', new URL(import.meta.url).pathname], {
      env: { ...process.env, ZCODE_NATIVE_CONTROL_TEST_CHILD: '1', ZCODE_NATIVE_TEST_MARKER: marker },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const payload = { revision: 'test-revision', basedOnZCodeBuiltinRevision: 'builtin', providers: {}, states: {} };
    const child = spawnWorker();
    const replies = new Map<number | string, (value: any) => void>();
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { const value = JSON.parse(line); replies.get(value.id)?.(value); replies.delete(value.id); });
    const wait = (id: number | string) => new Promise<any>(resolve => { replies.set(id, resolve); });
    const send = (id: number, method: string, params: unknown) => {
      const response = wait(id);
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
      return response;
    };
    try {
      const entered = wait('test/entered');
      const writer = send(1, zcodeProtocolMethods.providerUpdateAccountConfig, payload);
      await entered;
      const frozen = await send(2, zcodeProtocolMethods.nativeMaintenanceFreeze, {});
      assert.equal(frozen.result.activity.frozen, true);
      assert.ok(frozen.result.activity.pending >= 1);
      await assert.rejects(stat(marker), { code: 'ENOENT' });
      const refused = await send(3, zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy, {
        workspace: { workspacePath: directory, workspaceKey: 'disposable' }, enabled: true,
      });
      assert.match(JSON.stringify(refused), /guard.nativeMaintenanceFrozen/);
      child.stdin.write(JSON.stringify({ method: 'test/unblock' }) + '\n');
      assert.equal((await writer).result.status, 'received');
      assert.equal(await readFile(marker, 'utf8'), payload.revision);
      const fresh = await send(4, zcodeProtocolMethods.nativeMaintenanceGetActivity, frozen.result.lease);
      assert.equal(fresh.result.pending, 0);
      assert.equal(fresh.result.frozen, true);
      child.stdin.end();
      await new Promise<void>((resolve, reject) => child.once('exit', code => code === 0 ? resolve() : reject(new Error(`child exit ${code}`))));
      const replacement = spawnWorker();
      const next = createInterface({ input: replacement.stdout })[Symbol.asyncIterator]();
      replacement.stdin.write(JSON.stringify({ id: 5, method: zcodeProtocolMethods.nativeMaintenanceFreeze, params: {} }) + '\n');
      const newLease = JSON.parse((await next.next()).value ?? 'null').result.lease;
      assert.notEqual(newLease.epoch, frozen.result.lease.epoch);
      replacement.stdin.write(JSON.stringify({ id: 6, method: zcodeProtocolMethods.nativeMaintenanceRelease, params: frozen.result.lease }) + '\n');
      assert.ok(JSON.parse((await next.next()).value ?? 'null').error);
      replacement.stdin.write(JSON.stringify({ id: 7, method: zcodeProtocolMethods.nativeMaintenanceGetActivity, params: newLease }) + '\n');
      assert.equal(JSON.parse((await next.next()).value ?? 'null').result.frozen, true);
      replacement.stdin.end();
      await new Promise<void>((resolve, reject) => replacement.once('exit', code => code === 0 ? resolve() : reject(new Error(`replacement exit ${code}`))));
    } finally {
      if (!child.killed) { child.stdin.end(); }
      // Disposable test artifact remains in OS temp only; never touches user data.
    }
  });

}
