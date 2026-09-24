import assert from 'node:assert/strict';
import { test } from 'node:test';
import { zcodeProtocolMethods } from '@zcode/shared';
import { V4_METHODS } from '@zcode/shared/zcode-protocol-v4';
import { ZCodeProtocolAgentServer } from './server.js';

const workspace = { workspacePath: '/disposable', workspaceKey: 'disposable' };
const digest = 'a'.repeat(64);
const requests = [
  [zcodeProtocolMethods.workspaceHookTrustGrant, { workspace, bundleDigest: digest, hookDeclarationDigest: digest }],
  [zcodeProtocolMethods.workspaceUpdateInteractionPreferences, { workspace, preferences: { askUserQuestionAutoResolutionEnabled: false } }],
  [zcodeProtocolMethods.workspaceUpdateModelIoPreferences, { workspace, preferences: { fullRetentionEnabled: true } }],
  [zcodeProtocolMethods.workspaceUpdateOffPeakToolPolicy, { workspace, enabled: true }],
  [zcodeProtocolMethods.workspaceUpdateDynamicWorkflowPolicy, { workspace, enabled: true }],
  [zcodeProtocolMethods.providerUpdateAccountConfig, { revision: 'r1', basedOnZCodeBuiltinRevision: 'builtin', providers: {}, states: {} }],
  [V4_METHODS.command, { commandId: 'late', clientId: 'disposable', sessionId: null, type: 'createSession', payload: { workspaceId: 'disposable' }, issuedAt: Date.now() }],
] as const;

test('pending trust/preference/policy writers are registered before residency await, then fenced without effects', async () => {
  const server = new ZCodeProtocolAgentServer({ createZCodeApp: () => { throw new Error('unexpected agent'); },
    syncAccountProviderConfig: async () => { throw new Error('unexpected config write'); },
  });
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  // Test-only deferred real residency lease: forces all requests to cross the production await.
  // In production this await occurs during cold resident deactivation.
  const context = (server as unknown as { context: { sessionResidentPool: { acquireOperation: (ids: string[]) => Promise<() => void> } } }).context;
  const acquire = context.sessionResidentPool.acquireOperation.bind(context.sessionResidentPool);
  let entered = 0;
  context.sessionResidentPool.acquireOperation = async (ids) => { entered++; await blocked; return acquire(ids); };
  const pending = requests.map(([method, params], i) => server.handleMessage({ id: i + 1, method, params }));
  try {
    assert.equal(entered, requests.length);
    const freeze = await server.handleMessage({ id: 100, method: zcodeProtocolMethods.nativeMaintenanceFreeze, params: {} });
    assert.ok(freeze && 'result' in freeze);
    if (!freeze || !('result' in freeze)) return;
    const { lease, activity } = freeze.result as { lease: { epoch: string; leaseId: string }; activity: { pending: number; frozen: boolean } };
    assert.equal(activity.frozen, true);
    assert.ok(activity.pending >= requests.length);
    release();
    const results = await Promise.all(pending);
    for (const result of results) assert.match(JSON.stringify(result), /guard.nativeMaintenanceFrozen/);
    const fresh = await server.handleMessage({ id: 101, method: zcodeProtocolMethods.nativeMaintenanceGetActivity, params: lease });
    assert.ok(fresh && 'result' in fresh);
    assert.equal((fresh.result as { pending: number }).pending, 0);
    // Inventory: new execution, persisted plugin/workflow edits, attachment upload, network probe
    // and unknown future methods must all fail closed even when their payload is not yet parsed.
    for (const method of [
      'future/unknownWriter', zcodeProtocolMethods.sessionClose,
      zcodeProtocolMethods.workflowsUpdateMeta, zcodeProtocolMethods.pluginsMarketplaceAdd,
      zcodeProtocolMethods.pluginsInstall, V4_METHODS.attachmentBegin,
      zcodeProtocolMethods.providerTestModelConnectivity,
    ]) {
      const invalid = await server.handleMessage({ id: 102, method, params: {} });
      assert.match(JSON.stringify(invalid), /guard.nativeMaintenanceFrozen/, method);
    }
    const read = await server.handleMessage({ id: 103, method: zcodeProtocolMethods.runtimeCapabilities, params: {} });
    assert.ok(read && 'result' in read);
    const query = await server.handleMessage({ id: 104, method: V4_METHODS.commandsQuery, params: { keys: [] } });
    assert.doesNotMatch(JSON.stringify(query), /guard.nativeMaintenanceFrozen/);
    const stale = await server.handleMessage({ id: 105, method: zcodeProtocolMethods.nativeMaintenanceRelease, params: { ...lease, leaseId: '00000000-0000-4000-8000-000000000000' } });
    assert.ok(stale && 'error' in stale);
    assert.match(JSON.stringify(await server.handleMessage({ id: 106, method: zcodeProtocolMethods.nativeMaintenanceGetActivity, params: lease })), /"frozen":true/);
    await server.handleMessage({ id: 107, method: zcodeProtocolMethods.nativeMaintenanceRelease, params: lease });
  } finally {
    release();
    await Promise.all(pending);
    await server.shutdown();
    server.disposeProjections();
  }
});
