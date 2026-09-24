import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath, readdir, writeFile } from 'node:fs/promises';
import { relative, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const exec = promisify(execFile);
const checkout = fileURLToPath(new URL('../../../..', import.meta.url));
const within = (parent, child) => { const r = relative(parent, child); return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };

// No product import, subprocess, provider resolution, or browser launch precedes this assertion.
export async function assertIsolated(input) {
  const root = await realpath(input.root);
  if (!within(await realpath(input.artifacts), root) || root === await realpath(input.artifacts) && !root.includes('load-')) throw new Error('load artifact root required');
  for (const [key, path] of Object.entries(input.isolation)) {
    if (!within(root, await realpath(path))) throw new Error(`isolation escaped root: ${key}`);
  }
  const permitted = new Set(['PATH','LANG','LC_ALL','TZ','HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','ZCODE_DATA_BASE_DIR','TMPDIR']);
  for (const key of Object.keys(process.env)) if (!permitted.has(key)) throw new Error('untrusted inherited environment before product import');
  for (const [key, path] of Object.entries({ HOME:input.isolation.home, XDG_CONFIG_HOME:input.isolation.xdgConfig, XDG_DATA_HOME:input.isolation.xdgData, ZCODE_DATA_BASE_DIR:input.isolation.desktopUserData, TMPDIR:input.isolation.temporary })) {
    if (process.env[key] !== path) throw new Error(`effective process isolation missing: ${key}`);
  }
  if (!within(root, await realpath(input.repo)) || !(await realpath(input.repo)).startsWith(root + '/')) throw new Error('repository not disposable');
  for (const path of input.worktrees) if (!within(root, await realpath(path))) throw new Error('foreign worktree');
  return root;
}

// Trusted synthetic adapter: only inert canonical events; never resolves a Model, calls the CLI, or mutates files.
class LoadHarness {
  id = 'load-synthetic';
  version = '1.0.0';
  hostManagedRoute = 'mock';
  #states = new Map();
  #listeners = new Map();
  async probe() { return {support:'supported'}; }
  async hostManagedSupport() { return {support:'supported'}; }
  async capabilities() { return {text:{support:'supported'},tools:{support:'unsupported',reason:'load only'},approvals:{support:'unsupported',reason:'load only'},cancelTurn:{support:'unsupported',reason:'load only'},resumeExecution:{support:'unsupported',reason:'load only'},history:{support:'supported'},images:{support:'unsupported',reason:'load only'},modelSwitch:{support:'unsupported',reason:'load only'},detach:{support:'supported'},terminateSession:{support:'supported'},viewHistory:{support:'supported'},hostManagedModel:{support:'supported'},fork:{support:'unsupported',reason:'load only'},subagents:{support:'unsupported',reason:'load only'}}; }
  async create(spec) {
    if (this.#states.has(spec.hostSessionId)) throw new Error('duplicate synthetic session');
    const binding = {schemaVersion:2,targetId:spec.execution.targetId,workspaceId:spec.workspaceId,worktreeGeneration:spec.execution.worktreeGeneration,harnessId:this.id,hostSessionId:spec.hostSessionId,backendSessionId:`synthetic-${randomUUID()}`,backendVersion:this.version,runtimeEpoch:randomUUID()};
    this.#states.set(spec.hostSessionId,{binding,sequence:0});
    return binding;
  }
  async attach(spec,binding) { if (this.#states.get(spec.hostSessionId)?.binding.runtimeEpoch !== binding.runtimeEpoch) throw new Error('synthetic runtime not attached'); }
  async send() { throw new Error('load harness cannot send prompts'); }
  async cancelTurn() { throw new Error('load harness cannot accept commands'); }
  async resolveInteraction() { throw new Error('load harness cannot approve tools'); }
  async terminate(id) { this.#states.delete(id); }
  subscribe(id,fn) { const listeners = this.#listeners.get(id) ?? new Set(); listeners.add(fn); this.#listeners.set(id,listeners); return () => { listeners.delete(fn); if (!listeners.size) this.#listeners.delete(id); }; }
  emit(id,eventId) {
    const state = this.#states.get(id);
    if (!state || !/^[a-z0-9-]+$/.test(eventId)) throw new Error('invalid synthetic event');
    const event = {kind:'extension.event',namespace:'load.synthetic',version:1,payload:{},hostSessionId:id,runtimeEpoch:state.binding.runtimeEpoch,sequence:++state.sequence,eventId,at:state.sequence};
    for (const fn of this.#listeners.get(id) ?? []) fn(event);
    return event.sequence;
  }
}

// This is an actual Target/Catalog/Host composition, not a replacement in-memory journal or fake worktree list.
export async function createProductionBackend(input) {
  await assertIsolated(input);
  const {register} = await import('tsx/esm/api');
  const unregister = register();
  let target, catalog, host;
  try {
    const [worktrees, bridgeModule, catalogModule, registryModule, hostModule] = await Promise.all([
      import('../../../../packages/services/src/project-workspaces/worktreeService.ts'),
      import('../../../../packages/services/src/project-workspaces/targetBridge.ts'),
      import('../../../../packages/services/src/project-workspaces/projectCatalog.ts'),
      import('../../../../packages/services/src/agent-host/harnessRegistry.ts'),
      import('../../../../packages/services/src/agent-host/targetService.ts'),
    ]);
    const runRoot = await realpath(input.root);
    let hostRef;
    target = await worktrees.TargetWorktreeService.open({storageDirectory:join(runRoot,'target-owner'),executionTargetId:'load-local',activity:async workspaceId => {
      if (!hostRef) return {running:0,waiting:0,tools:0,uncertain:1,offline:true};
      const activity = await hostRef.getRuntimeActivity(workspaceId);
      return {...activity,tools:0,offline:false};
    }});
    const bridge = new bridgeModule.ProjectCatalogTargetBridge(target,'load-local',(_id,canonical) => canonical);
    const adoptedIds = new Set();
    const index = {
      async allSessions() {
        if (!hostRef) throw new Error('Host index unavailable');
        const batches = await Promise.all([...adoptedIds].map(id=>hostRef.listWorkspaceSessions(id)));
        const activity=await Promise.all([...adoptedIds].map(id=>hostRef.getRuntimeActivity(id)));
        const byWorkspace=new Map([...adoptedIds].map((id,i)=>[id,activity[i]]));
        return batches.flat().map(({spec,state,updatedAt},sortOrder)=>{
          const owner=byWorkspace.get(spec.workspaceId);
          const idle=state==='running' && owner?.running===0 && owner?.waiting===0 && owner?.uncertain===0;
          return {session:{schemaVersion:1,id:spec.hostSessionId,projectId:spec.projectId,workspaceId:spec.workspaceId,harnessId:spec.harness.id,title:spec.hostSessionId,sortOrder,archived:state==='terminated'},
            updatedAt:Math.floor(updatedAt),activity:idle ? 'idle' : 'unknown',freshness:owner?.uncertain ? 'unknown' : 'live',unread:false};
        });
      },
      async workspaceFreshness(workspace) {
        if (!hostRef) return 'unknown';
        const activity=await hostRef.getRuntimeActivity(workspace.id);
        return activity.uncertain ? 'unknown' : 'live';
      },
    };
    catalog = await catalogModule.ProjectCatalog.open(join(runRoot,'load-catalog.json'),bridge,index);
    await catalog.importProject({id:'load-project',bindingId:'load-binding',name:'Disposable Load',targetId:'load-local',repositoryPath:input.repo});
    const registry = new registryModule.HarnessRegistry();
    const harness = new LoadHarness();
    registry.registerTrusted({schemaVersion:1,id:harness.id,name:'Load synthetic',adapterVersion:harness.version},()=>harness);
    const workspaceAdmission = new bridgeModule.CatalogWorkspaceAdmission(catalog,target,'load-local');
    host = new hostModule.AgentHostTargetService({root:join(runRoot,'host-journal'),target:{id:'load-local',kind:'local',platform:process.platform,available:true},catalog:{fingerprint:'load-only',validateSelection:()=>({ok:true})},registry,admission:{verify:spec=>workspaceAdmission.verify(spec),withAdmission:(spec,action)=>workspaceAdmission.withAdmission(spec,canonicalCwd=>action({canonicalCwd}))}});
    hostRef = host;
    const specs = new Map();
    const candidates = new Map();
    let unsubscribe;
    let ownerEvents = 0;
    let liveCursor = new Map();
    let detached = false;
    const onEvent = ({spec,event}) => { ownerEvents++; if (!detached && input.delivery === 'desktop-continuous') liveCursor.set(spec.hostSessionId,event.sequence); };
    const source = {
      target,catalog,host,harness,specs,
      async discover({repo,candidates:paths}) {
        if (await realpath(repo) !== await realpath(input.repo) || paths.length !== input.worktrees.length || paths.some((p,i)=>p!==input.worktrees[i])) throw new Error('foreign fixture');
        const found = await catalog.discover('load-binding');
        const byPath = new Map(await Promise.all(found.map(async c=>[await realpath(c.worktreePath),c])));
        if (byPath.size !== paths.length) throw new Error('Target discovery count mismatch');
        return await Promise.all(paths.map(async (path,i) => { const canonical=await realpath(path); if (!byPath.has(canonical)) throw new Error('undiscovered real Git worktree'); const c = byPath.get(canonical); const id = `load-workspace-${i}`; candidates.set(id,c); return {id,path}; }));
      },
      async prepareSessions({expandedWorktrees,sessions}) {
        const expanded = new Map();
        for (const {id,path} of expandedWorktrees) {
          const candidate = candidates.get(id);
          if (!candidate || await realpath(candidate.worktreePath) !== await realpath(path)) throw new Error('unverified candidate');
          expanded.set(id,await catalog.adopt({bindingId:'load-binding',workspaceId:id,title:`Workspace ${id}`,worktreePath:path}));
          adoptedIds.add(id);
        }
        if (new Set(sessions.map(s=>s.workspaceId)).size !== expanded.size) throw new Error('sessions do not cover expanded workspaces');
        for (const session of sessions) {
          const workspace = expanded.get(session.workspaceId);
          if (!workspace || specs.has(session.id)) throw new Error('foreign or duplicate synthetic session');
          const spec = {schemaVersion:2,hostSessionId:session.id,projectId:'load-project',workspaceId:workspace.id,execution:{targetId:'load-local',workspaceIdentity:workspace.workspaceIdentity,worktreePath:workspace.worktreePath,worktreeGeneration:workspace.worktreeGeneration,cwdRelativeToWorktree:'.'},harness:{id:harness.id,adapterVersion:harness.version},modelBinding:{kind:'host-managed',selection:{providerId:'load-no-provider',modelId:'load-no-model'}}};
          await host.create(spec,`load-create-${session.id}`);
          specs.set(session.id,spec);
          liveCursor.set(session.id,0);
        }
        unsubscribe = host.subscribe(onEvent);
        return await catalog.sidebarSnapshot();
      },
      async emitCommitted({sessionId,eventId}) {
        const spec = specs.get(sessionId);
        if (!spec) throw new Error('unknown session');
        const sequence = harness.emit(sessionId,eventId);
        // Host serializes and fsyncs source events before resolving this owner read.
        const committed = await host.eventsSince(spec,sequence-1);
        if (committed.length !== 1 || committed[0].sequence !== sequence || committed[0].sourceEventId !== eventId) throw new Error('owner commit not visible');
        return sequence;
      },
      async ownerRows(sessionId,cursor=0) { const spec=specs.get(sessionId); if (!spec) throw new Error('unknown session'); return host.eventsSince(spec,cursor); },
      async detach() { detached=true; if (input.delivery === 'desktop-continuous') { unsubscribe?.(); unsubscribe=undefined; } },
      async reconnect() {
        // Query-only recovery. Desktop resubscribes to live events after querying gap; Web uses replay by owner cursor.
        for (const [id,spec] of specs) {
          let cursor = liveCursor.get(id) ?? 0;
          while (true) {
            const batch = await host.eventsSince(spec,cursor);
            if (!batch.length) break;
            for (const event of batch) { if (event.sequence !== ++cursor) throw new Error('owner journal gap'); }
          }
          const snapshot = await host.snapshot(spec);
          if (snapshot.seq !== cursor) throw new Error('owner snapshot gap');
          liveCursor.set(id,cursor);
        }
        detached=false;
        if (input.delivery === 'desktop-continuous') unsubscribe=host.subscribe(onEvent);
        return {replayedWithoutResend:true,caughtUp:true};
      },
      get observed() {return {ownerEvents,liveCursor:new Map(liveCursor)};},
      async close() {
        unsubscribe?.();
        try {await host?.close();} finally {try {await catalog?.close();} finally {await target?.close(); unregister();}}
        const files=[...(await readdir(join(runRoot,'host-journal'))),...(await readdir(join(runRoot,'target-owner'))),...(await readdir(runRoot)).filter(name=>name==='load-catalog.json.lock')];
        if (files.some(name=>name.endsWith('.lock') || name.endsWith('.owner'))) throw new Error('owned Host/Catalog/Target lease remains after close');
        // No driver-owned process is spawned. Git fixture children belong to runner and have exited before open.
        await writeFile(join(runRoot,'driver-cleanup.json'),JSON.stringify({hostClosed:true,catalogClosed:true,targetClosed:true,ownedChildProcesses:0,ownerLocks:0})+'\n');
      },
    };
    return source;
  } catch (error) {
    try {await host?.close();} finally {try {await catalog?.close();} finally {await target?.close(); unregister();}}
    throw error;
  }
}

// 中文：顶层 disposer 在 open 前就可调用；部分打开、正常 close 和 runner 重试清理只关闭同一 owner 一次。
let activeOwner, closed = false;
async function disposeOwner() {
  if (closed) return;
  closed = true;
  const owner = activeOwner;
  activeOwner = undefined;
  await owner?.close();
}
export default {
  sourceCheckout: checkout,
  dispose: disposeOwner,
  async open(input) {
    if (closed || activeOwner) throw new Error('driver cannot be reused after disposal');
    if (typeof input.registerCleanup !== 'function' || typeof input.registerChild !== 'function') throw new Error('runner cleanup registry required');
    input.registerCleanup(disposeOwner);
    await assertIsolated(input);
    if (!['desktop-continuous','web-remote-replayable'].includes(input.delivery)) throw new Error('explicit delivery mode required');
    if (input.sourceCheckout && await realpath(input.sourceCheckout) !== await realpath(checkout)) throw new Error('driver source checkout mismatch');
    const {stdout} = await exec('git',['rev-parse','HEAD'],{cwd:checkout,env:{PATH:process.env.PATH,HOME:input.isolation.home,GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_NOSYSTEM:'1'}});
    const owner = await createProductionBackend(input);
    activeOwner = owner;
    return {
      metadata:{productionCommit:stdout.trim(),driverVersion:'production-driver-1',paths:input.isolation},
      discover:args=>owner.discover(args),
      async mount(args) {
        await owner.prepareSessions(args);
        // This checkout's WorkspaceShellLayout has no mountedOwner/scoped external route. A sidebar fixture
        // or a standalone SessionPane is NOT an actual Shell->Sidebar->Pane production mount.
        throw new Error('missing committed WorkspaceShellLayout mountedOwner/mountedSessionRouting + real browser attachment port (shell-pane)');
      },
      async emit(args) {return owner.emitCommitted(args);},
      async detach() {return owner.detach();},
      async reconnect() {return owner.reconnect();},
      async sample() {throw new Error('no real mounted browser paint sampler');},
      async facts() {throw new Error('no separate mounted Host/renderer process metrics or owner-derived UI cursor');},
      async close() {await disposeOwner();},
    };
  },
};
