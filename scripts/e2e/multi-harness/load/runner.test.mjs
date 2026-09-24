import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFixture, runLoad, validateOptions } from './runner.mjs';

const temp = () => mkdtemp(join(tmpdir(), 'load-contract-test-'));

test('acceptance cannot be downgraded to smoke minimums', () => {
  assert.throws(() => validateOptions({ mode: 'acceptance', durationMs: 50, eventCount: 30 }), /8 hours/);
  assert.throws(() => validateOptions({ mode: 'acceptance', durationMs: 28_800_000, eventCount: 30 }), /100000/);
  assert.throws(() => validateOptions({ mode: 'acceptance', durationMs: 28_800_000, eventCount: 100000, worktreeCount: 4 }), /50/);
});

test('50 Git candidates are real disposable worktrees including main; no project path', async () => {
  const fixture = await createFixture(await temp(), 50);
  assert.equal(fixture.worktrees.length, 50);
  assert.notEqual(await realpath(fixture.repo), await realpath(process.cwd()));
  for (const path of fixture.worktrees) assert.match(await readFile(join(path, 'tiny.txt'), 'utf8'), /tiny fixture/);
});

function driver({ bad = false, missing = false } = {}) {
  let events = 0, detached = false, samples = 0, closed = false, reconnects = 0;
  return {
    async open(input) {
      assert.match(input.isolation.home, /load-/);
      return {
        metadata: { productionCommit: 'test-only', driverVersion: 'contract-stub', paths: input.isolation },
        async discover({ candidates }) { return candidates.map((path, index) => ({ id: `candidate-${index}`, path })); },
        async mount({ sessions }) {
          assert.equal(new Set(sessions.map(s => s.id)).size, sessions.length);
          return { mountedSurfaces: bad ? ['Button'] : ['Shell', 'ProjectSidebar', 'SessionPane'], owner: 'durable-host', delivery: 'desktop-continuous' };
        },
        async emit() { events++; },
        async sample() { samples++; return { typedInputMs: 5, sessionSwitchMs: 7, focusStable: true, draftStable: true, selectedStable: true, worktreesStable: true }; },
        async detach() { detached = true; },
        async reconnect() { assert.ok(detached); detached = false; reconnects++; return { replayedWithoutResend: true, caughtUp: true }; },
        async facts() { return { durableEvents: missing ? undefined : events, backlog: 0, implicitCliStarts: 0, fullHistorySidebarReads: 0, worktreeMutations: 0, childProcesses: closed ? 0 : 2, acceptedPrompts: 0, focusStable: true, draftStable: true, selectedStable: true, heapBytes: 1000 + samples, rssBytes: 5000 + samples }; },
        async close() { closed = true; },
        get reconnects() { return reconnects; },
      };
    },
  };
}

test('short contract run records bounded measurements and never claims acceptance', async () => {
  const result = await runLoad({ driver: driver(), mode: 'smoke', artifactBase: await temp(), durationMs: 60, eventCount: 120, worktreeCount: 50, sessionCount: 10, expandedCount: 5, sampleEveryMs: 10, reconnectEveryMs: 15, idleMs: 5 });
  assert.equal(result.mode, 'smoke');
  assert.equal(result.status, 'smoke-only');
  assert.equal(result.discovered, 50);
  assert.equal(result.committedEvents, 120);
  assert.ok(result.reconnects >= 1);
  assert.ok(result.samples.typedInputMs.length > 0);
  assert.equal(result.cleanup.childProcesses, 0);
  assert.equal(result.comparison.status, 'missing-baseline');
  assert.equal(JSON.parse(await readFile(join(result.artifacts, 'result.json'), 'utf8')).status, 'smoke-only');
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
