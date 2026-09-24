import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createFixture} from './runner.mjs';
import driver,{assertIsolated,createProductionBackend} from './production-driver.mjs';

async function fixture(count=6) {
  const root=await mkdtemp(join(tmpdir(),'load-prod-test-'));
  const isolation={home:join(root,'home'),xdgConfig:join(root,'xdg-config'),xdgData:join(root,'xdg-data'),desktopUserData:join(root,'desktop-user-data'),webProfile:join(root,'web-profile'),temporary:join(root,'temporary')};
  for(const path of Object.values(isolation)) await mkdir(path);
  const {repo,worktrees}=await createFixture(root,count);
  return {root,artifacts:root,repo,worktrees,isolation,mode:'smoke'};
}
async function isolated(input,callback) {
  const names={HOME:input.isolation.home,XDG_CONFIG_HOME:input.isolation.xdgConfig,XDG_DATA_HOME:input.isolation.xdgData,ZCODE_DATA_BASE_DIR:input.isolation.desktopUserData,TMPDIR:input.isolation.temporary};
  const prior={...process.env};
  for(const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env,Object.fromEntries(['PATH','LANG','LC_ALL','TZ'].filter(key=>prior[key]!==undefined).map(key=>[key,prior[key]])),names);
  try {return await callback();} finally {for(const key of Object.keys(process.env)) delete process.env[key]; Object.assign(process.env,prior);}
}

test('refuses HOME and symlink/foreign worktree before product imports',async()=>{
  const input=await fixture(2);
  await assert.rejects(assertIsolated(input),/effective process isolation|untrusted inherited environment/);
  await isolated(input,async()=>{
    await assertIsolated(input);
    await assert.rejects(assertIsolated({...input,worktrees:[...input.worktrees,process.cwd()]}),/foreign worktree/);
    process.env.PROVIDER_SECRET='blocked';
    await assert.rejects(assertIsolated(input),/untrusted inherited environment/);
    delete process.env.PROVIDER_SECRET;
  });
});

for(const delivery of ['desktop-continuous','web-remote-replayable']) test(`real Target/Catalog/Host ${delivery}: six Git worktrees, ten sessions, durable synthetic events, query-only replay`,async()=>{
  const input={...(await fixture()),delivery};
  await isolated(input,async()=>{
    const owner=await createProductionBackend(input);
    try {
      const discovered=await owner.discover({repo:input.repo,candidates:input.worktrees});
      assert.equal(discovered.length,6);
      const expanded=discovered.slice(0,5);
      const sessions=Array.from({length:10},(_,i)=>({id:`synthetic-${i}`,workspaceId:expanded[i%5].id}));
      const sidebar=await owner.prepareSessions({expandedWorktrees:expanded,sessions});
      assert.equal(sidebar.workspaces.length,5);
      assert.equal(sidebar.sessions.length,10);
      assert.ok(sidebar.sessions.every(s=>s.freshness==='live' && s.session.harnessId==='load-synthetic'));
      assert.equal((await owner.host.listWorkspaceSessions(expanded[0].id)).length,2);
      await owner.emitCommitted({sessionId:'synthetic-0',eventId:'synthetic-event-0'});
      const before=(await owner.ownerRows('synthetic-0',0))[0];
      assert.equal(before.kind,'extension.event');
      assert.equal(before.sourceEventId,'synthetic-event-0');
      assert.equal((await owner.host.snapshot(owner.specs.get('synthetic-0'))).seq,1);
      await owner.detach();
      await owner.emitCommitted({sessionId:'synthetic-0',eventId:'synthetic-event-1'});
      assert.deepEqual(await owner.reconnect(),{replayedWithoutResend:true,caughtUp:true});
      assert.equal(owner.observed.liveCursor.get('synthetic-0'),2);
      assert.equal((await owner.host.queryCreationCommand('load-create-synthetic-0')).receipt.status,'completed');
      assert.equal((await owner.ownerRows('synthetic-0',1)).length,1);
      const raw=await readFile(join(input.root,'load-catalog.json'),'utf8');
      assert.match(raw,/load-workspace-0/);
    } finally {await owner.close(); assert.deepEqual(JSON.parse(await readFile(join(input.root,'driver-cleanup.json'),'utf8')),{hostClosed:true,catalogClosed:true,targetClosed:true,ownedChildProcesses:0,ownerLocks:0});}
  });
});

test('driver refuses to claim mounted product UI on checkout without shell external route',async()=>{
  const input={...(await fixture(2)),delivery:'desktop-continuous'};
  await isolated(input,async()=>{
    const product=await driver.open(input);
    try {
      const found=await product.discover({repo:input.repo,candidates:input.worktrees});
      await assert.rejects(product.mount({expandedWorktrees:found.slice(0,1),sessions:[{id:'synthetic-0',workspaceId:found[0].id}]}),/missing committed WorkspaceShellLayout/);
      await assert.rejects(product.sample(),/no real mounted browser/);
      await assert.rejects(product.facts(),/no separate mounted Host/);
    } finally {await product.close();}
  });
});

test('50 discovered real Git worktrees and 10 durable Host sessions across five Catalog workspaces',async()=>{
  const input={...(await fixture(50)),delivery:'desktop-continuous'};
  await isolated(input,async()=>{
    const owner=await createProductionBackend(input);
    try {
      const discovered=await owner.discover({repo:input.repo,candidates:input.worktrees});
      assert.equal(discovered.length,50);
      const expanded=discovered.slice(0,5);
      const sessions=Array.from({length:10},(_,i)=>({id:`synthetic-${i}`,workspaceId:expanded[i%5].id}));
      const snapshot=await owner.prepareSessions({expandedWorktrees:expanded,sessions});
      assert.equal(snapshot.sessions.length,10);
      for(let i=0;i<30;i++) await owner.emitCommitted({sessionId:sessions[i%10].id,eventId:`event-${i}`});
      for(const session of sessions) assert.equal((await owner.ownerRows(session.id)).length,3);
      await owner.detach();
      assert.deepEqual(await owner.reconnect(),{replayedWithoutResend:true,caughtUp:true});
    } finally {await owner.close(); assert.deepEqual(JSON.parse(await readFile(join(input.root,'driver-cleanup.json'),'utf8')),{hostClosed:true,catalogClosed:true,targetClosed:true,ownedChildProcesses:0,ownerLocks:0});}
  });
});
