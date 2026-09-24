import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, access } from 'node:fs/promises';
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

function driver({ bad = false, missing = false, backlog = 0, lingering = false, delivery = 'desktop-continuous', gateway = false } = {}) {
  let events = 0, detached = false, samples = 0, closed = false, reconnects = 0;
  return {
    async open(input) {
      assert.match(input.isolation.home, /load-/);
      return {
        metadata: { productionCommit: 'test-only', driverVersion: 'contract-stub', paths: input.isolation },
        async discover({ candidates }) { return candidates.map((path, index) => ({ id: `candidate-${index}`, path })); },
        async mount({ sessions }) {
          assert.equal(new Set(sessions.map(s => s.id)).size, sessions.length);
          return { mountedSurfaces: bad ? ['Button'] : ['Shell', 'ProjectSidebar', 'SessionPane'], owner: 'durable-host', delivery };
        },
        async emit() { events++; },
        async sample() { samples++; return { typedInputMs: 5, sessionSwitchMs: 7, focusStable: true, draftStable: true, selectedStable: true, worktreesStable: true }; },
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
