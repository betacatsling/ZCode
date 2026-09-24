#!/usr/bin/env node
// Server1-only, zero-paid preflight. Product entrypoint/deployment is supplied by runtime-mount.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PAIRS = Object.freeze([
  ['stepfun', 'step-3.5-flash'],
  ['axonhub', 'deepseek-v4-flash'],
]);
const REQUIRED = Object.freeze([
  'packages/services/src/node.ts',
  'packages/services/src/agent-host/sessionHost.ts',
  'packages/services/src/agent-adapters/pi/piHarnessAdapter.ts',
  'apps/zcode-cli/packages/bootstrap/src/index.ts',
]);

// 修复依据：远端 profile 的 provider API 可能与本地不同；仅凭 model ID/凭据存在不可发起付费调用。
export function validateInventory(data) {
  assert.equal(data?.platform, 'linux');
  assert.equal(data?.arch, 'x64');
  assert.ok(Array.isArray(data?.providers));
  const providers = PAIRS.map(([provider, model]) => {
    const row = data.providers.find((item) => item.provider === provider && item.model === model);
    return { provider, model, api: row?.api ?? 'missing', ready: row?.api === 'anthropic-messages' && row?.credential === true && row?.endpoint === true && row?.modelExists === true };
  });
  return { node: data.node, providers, eligible: providers.every((row) => row.ready) };
}

// Bounded source-root check only; source existence does NOT assert a runnable Linux distribution.
export async function inspectSource(root) {
  const base = await realpath(root);
  const entries = [];
  for (const name of REQUIRED) {
    const path = join(base, name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || !(await realpath(path)).startsWith(base + '/')) {
      throw new Error('source-boundary-rejected');
    }
    entries.push(name);
  }
  const closure = await Promise.all([
    lstat(join(base, 'node_modules')).then(() => true, () => false),
    lstat(join(base, 'apps/zcode-cli/packages/bootstrap/dist')).then(() => true, () => false),
  ]);
  return { entries: entries.length, localPrerequisitesPresent: closure.every(Boolean) };
}

const inventoryCode = String.raw`
const fs=require('node:fs');
const os=require('node:os');
const pairs=[['stepfun','step-3.5-flash'],['axonhub','deepseek-v4-flash']];
let settings;
try { settings=JSON.parse(fs.readFileSync(os.homedir()+'/.pi/agent/models.json','utf8')); }
catch { settings={}; }
const providers=pairs.map(([provider,model])=>{
  const p=settings.providers?.[provider];
  return {provider,model,api:typeof p?.api==='string'&&['anthropic-messages','openai-completions'].includes(p.api)?p.api:'other-or-missing',credential:typeof p?.apiKey==='string'&&p.apiKey.length>0,endpoint:typeof p?.baseUrl==='string'&&p.baseUrl.length>0,modelExists:!!p?.models?.some(m=>m.id===model)};
});
process.stdout.write(JSON.stringify({platform:process.platform,arch:process.arch,node:process.version,providers})+'\n');
`;

function sshInventory() {
  return new Promise((resolvePromise, reject) => {
    // Script is static and contains only model names; remote settings never travel over SSH.
    const cmd = `node -e '${inventoryCode.replaceAll("'", "'\\''")}'`;
    const child = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'server1', cmd], { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > 2048) child.kill('SIGTERM');
    });
    child.on('error', () => { clearTimeout(timer); reject(new Error('remote-inventory-transport')); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 || stdout.length > 2048) return reject(new Error('remote-inventory-transport'));
      try { resolvePromise(validateInventory(JSON.parse(stdout))); }
      catch { reject(new Error('remote-inventory-shape')); }
    });
  });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  if (process.argv.length !== 2) {
    process.stderr.write('Usage: node scripts/e2e/multi-harness/live-remote-matrix.mjs\n');
    process.exitCode = 2;
  } else {
    try {
      const source = await inspectSource(process.cwd());
      const inventory = await sshInventory();
      const phase = !inventory.eligible ? 'target-profile-api-mismatch' : 'target-deployment-closure-unavailable';
      // No remote source or public client/V4 executable is deployed by this preflight.
      // Never pay for an isolated Model smoke or pretend a source tree is a packaged Core.
      process.stdout.write(JSON.stringify({ target: 'server1', phase, sourceFiles: source.entries, localPrerequisitesPresent: source.localPrerequisitesPresent, targetNode: inventory.node, providers: inventory.providers, requests: 0, certifiedPairs: 0, status: 'blocked' }) + '\n');
      process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`matrix-remote blocked: ${['source-boundary-rejected', 'remote-inventory-transport', 'remote-inventory-shape'].includes(error.message) ? error.message : 'source-or-inventory-unavailable'}\n`);
      process.exitCode = 1;
    }
  }
}
