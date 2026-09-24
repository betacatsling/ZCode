import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, access, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, runLoad, validateOptions, validateProductFacts, isolatedEnvironment } from './runner.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'load-contract-test-'));

test('launch environment does not inherit provider tokens or endpoints', () => {
  const env = isolatedEnvironment({PATH:'/bin',LANG:'C',AWS_ACCESS_KEY_ID:'hidden',MODEL_BASE_URL:'private',ANTHROPIC_AUTH_TOKEN:'hidden'}, {home:'/disposable',xdgConfig:'/disposable/config',xdgData:'/disposable/data',desktopUserData:'/disposable/desktop'});
  assert.equal(env.PATH,'/bin');
  assert.equal(env.HOME,'/disposable');
  assert.equal(env.AWS_ACCESS_KEY_ID,undefined);
  assert.equal(env.MODEL_BASE_URL,undefined);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN,undefined);
});

test('acceptance facts require separate host and renderer process metrics while mounted', () => {
  const facts = {durableEvents:0,backlog:0,backlogHighWater:0,implicitCliStarts:0,fullHistorySidebarReads:0,worktreeMutations:0,childProcesses:0,acceptedPrompts:0,focusStable:true,draftStable:true,selectedStable:true,heapBytes:1,rssBytes:1};
  assert.throws(() => validateProductFacts(facts,{mode:'acceptance',phase:'mounted'}), /product process/);
  facts.processes = {host:{heapBytes:100,rssBytes:200},renderer:{heapBytes:80,rssBytes:150}};
  assert.doesNotThrow(() => validateProductFacts(facts,{mode:'acceptance',phase:'mounted'}));
  delete facts.processes.renderer;
  assert.doesNotThrow(() => validateProductFacts(facts,{mode:'acceptance',phase:'post-idle'}));
});

test('acceptance cannot be downgraded to smoke minimums', () => {
  assert.throws(() => validateOptions({ mode: 'acceptance', durationMs: 50, eventCount: 30 }), /8 hours/);
  assert.throws(() => validateOptions({ mode: 'acceptance', durationMs: 28_800_000, eventCount: 30 }), /100000/);
  assert.throws(() => validateOptions({ mode: 'acceptance', durationMs: 28_800_000, eventCount: 100000, worktreeCount: 4, expandedCount: 4 }), /50/);
  assert.throws(() => validateOptions({ mode: 'acceptance', idleMs: 0 }), /idle/);
});

test('50 Git candidates are real disposable worktrees including main; no project path', async () => {
  const fixture = await createFixture(await temp(), 50);
  assert.equal(fixture.worktrees.length, 50);
  assert.notEqual(await realpath(fixture.repo), await realpath(process.cwd()));
  for (const path of fixture.worktrees) assert.match(await readFile(join(path, 'tiny.txt'), 'utf8'), /tiny fixture/);
});

function driver({ bad = false, missing = false, backlog = 0, lingering = false, delivery = 'desktop-continuous', gateway = false, productionCommit = 'test-only', latency = 5 } = {}) {
  let events = 0, detached = false, samples = 0, closed = false, reconnects = 0;
  return {
    async dispose() { closed = true; },
    async open(input) {
      assert.match(input.isolation.home, /load-/);
      return {
        metadata: { productionCommit, driverVersion: 'contract-stub', paths: input.isolation },
        async discover({ candidates }) { return candidates.map((path, index) => ({ id: `candidate-${index}`, path })); },
        async mount({ sessions }) {
          assert.equal(new Set(sessions.map(s => s.id)).size, sessions.length);
          return { mountedSurfaces: bad ? ['Button'] : ['Shell', 'ProjectSidebar', 'SessionPane'], owner: 'durable-host', delivery };
        },
        async emit() { events++; },
        async sample() { samples++; return { typedInputMs: latency, sessionSwitchMs: latency + 2, focusStable: true, draftStable: true, selectedStable: true, worktreesStable: true }; },
        async detach() { detached = true; },
        async reconnect() { assert.ok(detached); detached = false; reconnects++; return { replayedWithoutResend: true, caughtUp: true }; },
        async facts() { return { durableEvents: missing ? undefined : events, backlog, backlogHighWater: backlog, implicitCliStarts: 0, fullHistorySidebarReads: 0, worktreeMutations: 0, childProcesses: closed && !lingering ? 0 : 2, acceptedPrompts: 0, focusStable: true, draftStable: true, selectedStable: true, heapBytes: 1000 + samples, rssBytes: 5000 + samples }; },
        ...(gateway ? {async gatewayProbe() { return [1.2, 2.4, 3.1]; }} : {}),
        async close() { closed = true; },
        get reconnects() { return reconnects; },
      };
    },
  };
}

test('short contract run records bounded measurements and never claims acceptance', async () => {
  const result = await runLoad({ driver: driver({gateway:true}), mode: 'smoke', artifactBase: await temp(), durationMs: 60, eventCount: 120, worktreeCount: 50, sessionCount: 10, expandedCount: 5, sampleEveryMs: 10, reconnectEveryMs: 15, idleMs: 5 });
  assert.equal(result.mode, 'smoke');
  assert.equal(result.status, 'smoke-only');
  assert.equal(result.discovered, 50);
  assert.equal(result.committedEvents, 120);
  assert.ok(result.elapsedMs >= 60);
  assert.equal(result.expanded, 5);
  assert.equal(result.sessions, 10);
  assert.ok(result.reconnects >= 1);
  assert.ok(result.samples.typedInputMs.length > 0);
  assert.equal(result.cleanup.childProcesses, 0);
  assert.equal(result.comparison.status, 'missing-baseline');
  assert.equal(result.gateway.status, 'fake-provider-pure-adapter');
  assert.equal(result.gateway.p95Ms, 3.1);
  assert.equal(JSON.parse(await readFile(join(result.artifacts, 'result.json'), 'utf8')).status, 'smoke-only');
  console.log(`[contract-stub smoke, NOT product] worktrees=${result.discovered} sessions=${result.sessions} expanded=${result.expanded} committed=${result.committedEvents} elapsedMs=${Math.round(result.elapsedMs)} reconnects=${result.reconnects} typedP95=${result.p95.typedInputMs} switchP95=${result.p95.sessionSwitchMs} backlogMax=${result.backlogSummary.max} cleanupChildren=${result.cleanup.childProcesses} baseline=${result.comparison.status}`);
});

test('rejects detached UI and missing owner counters; still writes failure artifact', async () => {
  for (const options of [{ bad: true }, { missing: true }]) {
    const base = await temp();
    const result = await runLoad({ driver: driver(options), mode: 'smoke', artifactBase: base, durationMs: 1, eventCount: 1, worktreeCount: 2, sessionCount: 2, expandedCount: 1, sampleEveryMs: 1, reconnectEveryMs: 1, idleMs: 1 });
    assert.equal(result.status, 'failed');
    assert.ok(result.failures.length > 0);
    assert.equal(JSON.parse(await readFile(join(result.artifacts, 'result.json'), 'utf8')).status, 'failed');
  }
});

test('missing production driver fails closed before launch', () => assert.rejects(runLoad({mode:'smoke'}), /driver/));

test('artifact base inside project Git checkout is refused before any new directory', async () => {
  const path = join(process.cwd(),'.load-must-not-create-fixture-dir');
  await assert.rejects(runLoad({driver:driver(),mode:'smoke',artifactBase:path}), /outside/);
  await assert.rejects(access(path));
});

test('artifact base inside another real Git checkout is refused without creating a directory', async () => {
  const fixture = await createFixture(await temp(),1);
  const path = join(fixture.repo,'unsafe-artifacts');
  await assert.rejects(runLoad({driver:driver(),mode:'smoke',artifactBase:path}), /outside/);
  await assert.rejects(access(path));
});

test('backlog and orphan child fail gate, as does mismatched delivery', async () => {
  for (const options of [{backlog:1},{lingering:true},{delivery:'web-remote-replayable'}]) {
    const result = await runLoad({driver:driver(options),mode:'smoke',artifactBase:await temp(),durationMs:3,eventCount:2,worktreeCount:2,sessionCount:2,expandedCount:1,reconnectEveryMs:1,sampleEveryMs:1,idleMs:0});
    assert.equal(result.status,'failed');
    assert.ok(result.failures.length);
  }
});

test('baseline absent cannot produce a <=10% regression claim', async () => {
  const result = await runLoad({driver:driver(),mode:'smoke',artifactBase:await temp(),durationMs:3,eventCount:2,worktreeCount:2,sessionCount:2,expandedCount:1,reconnectEveryMs:1,sampleEveryMs:1,idleMs:0});
  assert.equal(result.comparison.status,'missing-baseline');
  assert.equal(result.comparison.typedInputRatio,undefined);
});

const short = { mode:'benchmark',benchmarkDatasetId:'fixed-fixture-v1',durationMs:10,eventCount:4,worktreeCount:2,sessionCount:2,expandedCount:1,sampleEveryMs:1,reconnectEveryMs:1,idleMs:0 };
async function preservedSource() {
  const {repo} = await createFixture(await temp(),1);
  const commit = execFileSync('git',['rev-parse','HEAD'],{cwd:repo,encoding:'utf8'}).trim();
  const buildArtifactPath = join(await temp(),'bundle.bin');
  await writeFile(buildArtifactPath,'preserved build '+commit);
  return {repo,commit,buildArtifactPath};
}
async function baselinePair({candidateLatency = 5, baselineMutate, candidateMutate} = {}) {
  const baseline = await preservedSource();
  const candidate = await preservedSource();
  // Same fixture seed does not mean the candidate was built from baseline HEAD.
  execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','candidate revision'],{cwd:candidate.repo});
  candidate.commit = execFileSync('git',['rev-parse','HEAD'],{cwd:candidate.repo,encoding:'utf8'}).trim();
  const baselineRun = await runLoad({...short, driver:driver({productionCommit:baseline.commit}),artifactBase:await temp(), sourceCheckout:baseline.repo, buildArtifactPath:baseline.buildArtifactPath});
  assert.equal(baselineRun.status,'latency-baseline-pending');
  const baselinePath = join(baselineRun.artifacts,'result.json');
  if (baselineMutate) {
    const edited = JSON.parse(await readFile(baselinePath,'utf8'));
    await baselineMutate(edited, baseline);
    await writeFile(baselinePath,JSON.stringify(edited));
  }
  if (candidateMutate) await candidateMutate(candidate);
  const result = await runLoad({...short,driver:driver({productionCommit:candidate.commit,latency:candidateLatency}),artifactBase:await temp(),baselinePath,sourceCheckout:candidate.repo,buildArtifactPath:candidate.buildArtifactPath});
  return {result,baseline,candidate};
}

test('partial open disposes registered real child exactly once and proves exit', async () => {
  let child, disposals = 0, cleanups = 0;
  const partial = {
    async dispose() { disposals++; if (child && child.exitCode === null && child.signalCode === null) child.kill(); },
    async open({registerCleanup,registerChild}) {
      registerCleanup(async () => { cleanups++; if (child && child.exitCode === null && child.signalCode === null) child.kill(); });
      child = spawn(process.execPath,['-e','setInterval(() => {}, 10000)'],{stdio:'ignore',env:{PATH:process.env.PATH}});
      registerChild(child);
      throw new Error('sensitive partial launch failure');
    },
  };
  const result = await runLoad({...short,driver:partial,artifactBase:await temp()});
  assert.equal(result.status,'failed');
  assert.ok(result.failures.includes('gate-failed:driver-open'));
  assert.equal(result.cleanup?.registeredChildrenExited,1);
  assert.equal(child.exitCode !== null || child.signalCode !== null,true);
  assert.equal(disposals,1); assert.equal(cleanups,1);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});

test('broken top-level disposer still reaps registered real child and fails cleanup', async () => {
  let child;
  const broken = {
    async dispose() { throw new Error('sensitive disposer failure'); },
    async open({registerChild}) {
      child = spawn(process.execPath,['-e','setInterval(() => {}, 10000)'],{stdio:'ignore'});
      registerChild(child);
      throw new Error('sensitive open failure');
    },
  };
  const result = await runLoad({...short,driver:broken,artifactBase:await temp()});
  assert.equal(result.status,'failed');
  assert.ok(result.failures.includes('gate-failed:cleanup-or-idle'));
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  assert.ok(!JSON.stringify(result).includes('sensitive'));
});

test('changed preserved baseline checkout cannot be adopted from unchanged JSON', async () => {
  const {result} = await baselinePair({baselineMutate:async (_json, baseline) => {
    execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','modified preserved baseline'],{cwd:baseline.repo});
  }});
  assert.equal(result.comparison.status,'incomparable-baseline');
});

test('wrong preserved Git HEAD cannot be adopted from baseline JSON', async () => {
  const {result} = await baselinePair({baselineMutate:async (json) => { json.metadata.productionCommit = 'a'.repeat(40); }});
  assert.equal(result.comparison.status,'incomparable-baseline');
});

test('candidate commit mismatch rejects self-reported driver provenance', async () => {
  const {result} = await baselinePair({candidateMutate:async candidate => { candidate.commit = 'a'.repeat(40); }});
  assert.equal(result.status,'failed');
  assert.ok(result.failures.includes('gate-failed:source-provenance'));
});

test('missing build or idle provenance is incomparable', async () => {
  for (const field of ['buildSha256','idleMs']) {
    const {result} = await baselinePair({baselineMutate:async json => {
      if (field === 'idleMs') delete json.config.idleMs;
      else delete json.metadata.buildSha256;
    }});
    assert.equal(result.comparison.status,'incomparable-baseline');
  }
});

test('tampered p95 does not launder preserved samples into a baseline', async () => {
  const {result} = await baselinePair({baselineMutate:async json => { json.p95.typedInputMs = 100; }});
  assert.equal(result.comparison.status,'incomparable-baseline');
});

test('controlled short latency window over budget is failed, not 8h', async () => {
  const {result} = await baselinePair({candidateLatency:6});
  assert.equal(result.status,'failed');
  assert.equal(result.comparison.status,'over-budget');
  assert.ok(result.failures.includes('gate-failed:latency-regression'));
  assert.equal(result.comparison.typedInputRatio,1.2);
});

test('preserved baseline with matching short controlled window is comparable but not 8h', async () => {
  const {result} = await baselinePair();
  assert.equal(result.comparison.status,'within-budget');
  assert.equal(result.status,'latency-measured');
});

// A real process, not a mocked kill/exit, must be reaped even if every untrusted cleanup hook hangs.
test('never-resolving close, registered cleanup and disposer cannot strand partial-open real child', {timeout: 8000}, async () => {
  for (const at of ['partial-open','mounted-close']) {
    let child; const never = () => new Promise(() => {});
    const owned = {
      dispose: never,
      async open({registerCleanup,registerChild,isolation}) {
        registerCleanup(never);
        child = spawn(process.execPath,['-e','setInterval(() => {}, 10000)'],{stdio:'ignore'});
        registerChild(child);
        if (at === 'partial-open') throw new Error('partial');
        const mount = await driver().open({isolation});
        return {...mount,close:never};
      },
    };
    const started = Date.now();
    const result = await runLoad({...short,driver:owned,artifactBase:await temp()});
    assert.ok(Date.now()-started < 6500, 'cleanup did not meet emergency deadline');
    assert.equal(result.status,'failed');
    assert.ok(result.failures.includes('gate-failed:cleanup-or-idle'));
    assert.equal(result.cleanup?.registeredChildrenExited,1);
    assert.ok(child.exitCode !== null || child.signalCode !== null);
    assert.equal(JSON.parse(await readFile(join(result.artifacts,'result.json'),'utf8')).status,'failed');
  }
});

test('benchmark must declare controlled measurement window and dataset; acceptance minima remain intact', () => {
  assert.throws(() => validateOptions({mode:'benchmark',durationMs:10}), /benchmarkDatasetId/);
  assert.throws(() => validateOptions({mode:'benchmark',benchmarkDatasetId:'x',durationMs:0}), /durationMs/);
  assert.throws(() => validateOptions({mode:'acceptance',durationMs:10,benchmarkDatasetId:'x'}), /8 hours/);
  assert.throws(() => validateOptions({mode:'acceptance',eventCount:10,benchmarkDatasetId:'x'}), /100000/);
});

test('smoke baseline is incomparable to controlled benchmark, mismatched window and dataset cannot pass', async () => {
  for (const change of [
    json => { json.mode='smoke'; },
    json => { json.config.durationMs++; },
    json => { json.config.benchmarkDatasetId='different'; },
    json => { json.elapsedMs=0; },
    json => { json.samples.typedInputMs=[]; },
    json => { json.samples.elapsedMs.fill(0); },
    json => { json.measurement.windowMs++; },
    json => { json.config.eventCount++; },
  ]) {
    const {result} = await baselinePair({baselineMutate:async json => change(json)});
    assert.equal(result.comparison.status,'incomparable-baseline');
    assert.equal(result.status,'latency-baseline-pending');
  }
});

test('unmarked fast smoke cannot make a latency claim even with preserved source and matching config', async () => {
  const {result} = await baselinePair({baselineMutate:async json => { json.mode='smoke'; }});
  assert.equal(result.comparison.status,'incomparable-baseline');
});

test('session-switch budget fails independently and exact benchmark provenance survives artifact', async () => {
  const {result} = await baselinePair({candidateLatency:5,baselineMutate:async json => {
    // Keep typed p95 intact; change only switch samples and its p95 to a valid lower baseline.
    json.samples.sessionSwitchMs = json.samples.sessionSwitchMs.map(() => 5);
    json.p95.sessionSwitchMs = 5;
  }});
  assert.equal(result.status,'failed');
  assert.equal(result.comparison.status,'over-budget');
  assert.equal(result.comparison.typedInputRatio,1);
  assert.equal(result.comparison.sessionSwitchRatio,1.4);
  const saved = JSON.parse(await readFile(join(result.artifacts,'result.json'),'utf8'));
  assert.equal(saved.measurement.windowMs,short.durationMs);
  assert.equal(saved.measurement.datasetId,short.benchmarkDatasetId);
  assert.ok(saved.samples.elapsedMs.at(-1) >= saved.measurement.windowMs);
});
