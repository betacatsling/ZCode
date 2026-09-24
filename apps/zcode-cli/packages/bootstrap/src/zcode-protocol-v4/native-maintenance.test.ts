import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CommandInbox } from './command-inbox.js';

test('freeze wins over an awaiting fresh admission; duplicate, query and stop remain lawful', async () => {
  let unblock!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => { unblock = resolve; });
  const seen = new Promise<void>(resolve => { entered = resolve; });
  const inbox = new CommandInbox({
    getRevision: () => 0, getLogEpoch: () => null,
    lookupTranscriptCommand: async key => {
      if (key.commandId === 'late') { entered(); await waiting; }
      return null;
    },
  });
  const send = (commandId: string, type = 'sendText', payload: object = { text: 'sample' }) =>
    ({ commandId, clientId: 'client', sessionId: 'session', type, payload, issuedAt: Date.now() });
  const late = inbox.handle(send('late'));
  await seen;
  const lease = inbox.freeze();
  assert.equal(inbox.maintenanceState.frozen, true);
  assert.equal(inbox.maintenanceState.pending > 0, true);
  unblock();
  const rejected = await late;
  assert.equal(rejected.kind, 'ack');
  if (rejected.kind === 'ack') assert.equal(rejected.ack.reasonCode, 'guard.nativeMaintenanceFrozen');
  const stop = await inbox.handle(send('stop-1', 'stop', {}));
  assert.equal(stop.kind, 'execute');
  if (stop.kind === 'execute') stop.settle({ status: 'accepted' });
  const duplicate = await inbox.handle(send('stop-1', 'stop', {}));
  assert.equal(duplicate.kind, 'ack');
  assert.equal((await inbox.query([{ sessionId: 'session', commandId: 'stop-1' }]))[0]?.result !== 'unknown', true);
  assert.equal(inbox.release({ ...lease, leaseId: '00000000-0000-4000-8000-000000000000' }), false);
  assert.equal(inbox.maintenanceState.frozen, true);
  assert.equal(inbox.release(lease), true);
  const next = await inbox.handle(send('next'));
  assert.equal(next.kind, 'execute');
  if (next.kind === 'execute') next.settle({ status: 'accepted' });
});
