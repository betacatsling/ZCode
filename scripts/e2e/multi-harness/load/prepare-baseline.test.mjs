import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,access} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {baselinePreflight,prepareBaseline} from './prepare-baseline.mjs';
const baseline=resolve(process.cwd(),'../multi-harness-baseline-prep');
const unavailable=!existsSync(join(baseline,'.git')); // linked worktree has a .git file; other checkouts skip only these local preparation tests
const temp=()=>mkdtemp(join(tmpdir(),'load-preserved-baseline-'));

test('preserved baseline is pinned, tracked clean and planned as serial real Desktop build (not Sidebar fixture)',{skip:unavailable},async()=>{
  const artifactBase=await temp();
  const result=await prepareBaseline({checkout:baseline,artifactBase});
  assert.equal(result.status,'blocked');
  assert.equal(result.productionCommit,execFileSync('git',['rev-parse','HEAD'],{cwd:baseline,encoding:'utf8'}).trim());
  assert.equal(result.commands.length,4);
  assert.ok(result.commands[0].includes('--workspace-concurrency=1'));
  assert.equal(result.commands[2].at(-1),'tsup');
  assert.deepEqual(result.commands[3].slice(-2),['vite','build']);
  await assert.rejects(access(join(artifactBase,'baseline-build-provenance.json')));
  await assert.rejects(baselinePreflight(baseline,join(baseline,'artifacts')),/external artifact/);
});

test('without dependencies no baseline build is claimed; blocked manifest and tracked source identity preserved',{skip:unavailable || existsSync(join(baseline,'node_modules'))},async()=>{
  const artifacts=await temp();
  const result=await prepareBaseline({checkout:baseline,artifactBase:artifacts,execute:true});
  assert.equal(result.status,'blocked');
  assert.match(result.blocker,/missing baseline dependencies/);
  const saved=JSON.parse(await readFile(join(artifacts,'baseline-build-provenance.json'),'utf8'));
  assert.equal(saved.postBuildCommit,result.productionCommit);
  assert.deepEqual(saved.artifactFiles,[]);
  assert.equal(execFileSync('git',['status','--porcelain','--untracked-files=no'],{cwd:baseline,encoding:'utf8'}).trim(),'');
});
