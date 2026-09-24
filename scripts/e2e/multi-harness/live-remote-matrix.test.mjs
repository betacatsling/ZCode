import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { inspectSource, validateInventory } from './live-remote-matrix.mjs';

const rows = (api = 'anthropic-messages') => ({ platform: 'linux', arch: 'x64', node: 'v20.19.2', providers: [
  { provider: 'stepfun', model: 'step-3.5-flash', api, credential: true, endpoint: true, modelExists: true },
  { provider: 'axonhub', model: 'deepseek-v4-flash', api: 'anthropic-messages', credential: true, endpoint: true, modelExists: true },
] });

test('exact profile API required for both pairs; no substitute model', () => {
  assert.equal(validateInventory(rows()).eligible, true);
  assert.equal(validateInventory(rows('openai-completions')).eligible, false);
  assert.equal(validateInventory({ ...rows(), providers: [rows().providers[0]] }).eligible, false);
  assert.throws(() => validateInventory({ ...rows(), platform: 'darwin' }));
});

test('source cannot be mistaken for a runnable distribution; no symlink expansion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-matrix-source-'));
  const paths = ['packages/services/src/node.ts', 'packages/services/src/agent-host/sessionHost.ts', 'packages/services/src/agent-adapters/pi/piHarnessAdapter.ts', 'apps/zcode-cli/packages/bootstrap/src/index.ts'];
  try {
    for (const path of paths) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), ''); }
    assert.deepEqual(await inspectSource(root), { entries: 4, localPrerequisitesPresent: false });
    await rm(join(root, paths[0]));
    await symlink('/etc/passwd', join(root, paths[0]));
    await assert.rejects(inspectSource(root), /source-boundary-rejected/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
