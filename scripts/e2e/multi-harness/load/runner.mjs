import { spawn } from 'node:child_process';
import { cpus, platform, arch, totalmem, tmpdir, hostname } from 'node:os';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';

const HOUR8 = 8 * 60 * 60 * 1000;
const LATENCY_BUDGET = 1.10;
const CLEANUP_DEADLINE_MS = 750;
const defaults = { delivery: 'desktop-continuous', mode: 'acceptance', durationMs: HOUR8, eventCount: 100_000, worktreeCount: 50, sessionCount: 10, expandedCount: 5, sampleEveryMs: 60_000, reconnectEveryMs: 300_000, idleMs: 60_000, maxBacklog: 10_000, maxOwnedChildren: 32 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const inside = (root, child) => { const r = relative(root, child); return r === '' || (r !== '..' && !r.startsWith('../') && !isAbsolute(r)); };
const machine = createHash('sha256').update(JSON.stringify({ platform: platform(), arch: arch(), hostname: hostname(), cpus: cpus().map(c => c.model), totalmem: totalmem() })).digest('hex').slice(0, 16);

export function validateOptions(input = {}) {
  const options = { ...defaults, ...input };
  if (!['smoke', 'benchmark', 'acceptance'].includes(options.mode)) throw new Error('invalid mode');
  if (!['desktop-continuous','web-remote-replayable'].includes(options.delivery)) throw new Error('invalid delivery');
  for (const key of ['durationMs','eventCount','worktreeCount','sessionCount','expandedCount','sampleEveryMs','reconnectEveryMs','idleMs','maxBacklog','maxOwnedChildren']) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === 'idleMs' ? 0 : 1)) throw new Error(`invalid ${key}`);
  }
  if (options.expandedCount > options.worktreeCount || options.sessionCount < options.expandedCount) throw new Error('invalid workspace/session distribution');
  if (options.mode === 'benchmark' && (typeof options.benchmarkDatasetId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(options.benchmarkDatasetId))) throw new Error('invalid benchmarkDatasetId');
  if (options.mode === 'acceptance') {
    if (options.durationMs < HOUR8) throw new Error('acceptance requires 8 hours elapsed');
    if (options.eventCount < 100_000) throw new Error('acceptance requires 100000 events');
    if (options.worktreeCount < 50) throw new Error('acceptance requires 50 worktrees');
    if (options.idleMs < 60_000) throw new Error('acceptance requires 60 seconds post-cleanup idle');
    if (options.sessionCount < 10 || options.expandedCount < 5) throw new Error('acceptance requires 10 sessions across 5 expanded workspaces');
  }
  return options;
}

async function git(cwd, ...args) {
  const child = spawn('git', args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: cwd, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  child.stdout.setEncoding('utf8').on('data', chunk => { out += chunk; });
  child.stderr.setEncoding('utf8').on('data', chunk => { err += chunk; });
  const code = await new Promise((res, rej) => { child.on('error', rej); child.on('close', res); });
  if (code !== 0) throw new Error(`disposable Git ${args[0]} failed (exit ${code}): ${err.slice(0, 300)}`);
  return out;
}

export async function createFixture(artifactDir, count) {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('invalid worktree count');
  const repo = join(artifactDir, 'tiny-git-repo');
  await mkdir(repo, { recursive: false });
  await git(repo, 'init', '-q');
  await writeFile(join(repo, 'tiny.txt'), 'tiny fixture\n');
  await git(repo, 'add', '--', 'tiny.txt');
  await git(repo, '-c', 'user.name=Load Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'tiny disposable fixture');
  const worktrees = [repo];
  for (let i = 1; i < count; i++) {
    const path = join(artifactDir, `linked-${String(i).padStart(3, '0')}`);
    await git(repo, 'worktree', 'add', '--detach', '-q', path, 'HEAD');
    worktrees.push(path);
  }
  // Read Git's actual registry, not an invented list of branches or folders.
  const registered = await git(repo, 'worktree', 'list', '--porcelain', '-z');
  const paths = registered.split('\0').filter(x => x.startsWith('worktree ')).map(x => x.slice(9));
  const canonical = await Promise.all(worktrees.map(w => realpath(w)));
  if (paths.length !== count || canonical.some(w => !paths.includes(w))) throw new Error('Git worktree registry mismatch');
  return { repo, worktrees };
}

function number(facts, key) { if (!Number.isFinite(facts?.[key]) || facts[key] < 0) throw new Error(`missing/invalid owner counter ${key}`); return facts[key]; }
function checkFacts(facts) {
  for (const key of ['durableEvents','backlog','backlogHighWater','implicitCliStarts','fullHistorySidebarReads','worktreeMutations','childProcesses','acceptedPrompts','heapBytes','rssBytes']) number(facts, key);
  if (facts.backlogHighWater < facts.backlog) throw new Error('invalid owner backlog high water');
  for (const key of ['focusStable','draftStable','selectedStable']) if (facts[key] !== true) throw new Error(`unstable owner fact ${key}`);
  for (const key of ['implicitCliStarts','fullHistorySidebarReads','worktreeMutations','acceptedPrompts']) if (facts[key] !== 0) throw new Error(`unexpected owner side effect ${key}: ${facts[key]}`);
  return facts;
}
export function validateProductFacts(facts, {mode, phase}) {
  checkFacts(facts);
  if (mode === 'acceptance') {
    const required = phase.startsWith('post-') ? ['host'] : ['host','renderer'];
    for (const processName of required) {
      const processFacts = facts.processes?.[processName];
      if (!processFacts || !Number.isFinite(processFacts.heapBytes) || processFacts.heapBytes <= 0 || !Number.isFinite(processFacts.rssBytes) || processFacts.rssBytes <= 0) throw new Error(`missing product process memory: ${processName}`);
    }
  }
  return facts;
}
function checkSample(sample) {
  for (const key of ['typedInputMs','sessionSwitchMs']) number(sample, key);
  for (const key of ['focusStable','draftStable','selectedStable','worktreesStable']) if (sample[key] !== true) throw new Error(`unstable mounted UI ${key}`);
}
function p95(values) { if (!values.length) return null; const sorted = [...values].sort((a,b) => a-b); return sorted[Math.ceil(sorted.length * .95) - 1]; }
async function isolation(root) {
  const paths = { home: join(root, 'home'), xdgConfig: join(root, 'xdg-config'), xdgData: join(root, 'xdg-data'), desktopUserData: join(root, 'desktop-user-data'), webProfile: join(root, 'web-profile'), temporary: join(root, 'temporary') };
  for (const path of Object.values(paths)) { await mkdir(path); if (!inside(root, await realpath(path))) throw new Error('isolation path escaped artifact root'); }
  return paths;
}
function metadataCheck(meta, paths, mode) {
  if (!meta || typeof meta.productionCommit !== 'string' || !/^[a-f0-9]{40}$/.test(meta.productionCommit) && !(mode === 'smoke' && meta.productionCommit === 'test-only') || !/^[a-zA-Z0-9._-]{1,64}$/.test(meta.driverVersion ?? '') || !meta.paths) throw new Error('missing driver provenance/isolation attestation');
  for (const [key, value] of Object.entries(paths)) if (meta.paths[key] !== value) throw new Error(`unverified effective ${key}`);
}
function configOf(o) { return { delivery:o.delivery,benchmarkDatasetId:o.mode === 'benchmark' ? o.benchmarkDatasetId : null,durationMs:o.durationMs,eventCount:o.eventCount,worktreeCount:o.worktreeCount,sessionCount:o.sessionCount,expandedCount:o.expandedCount,sampleEveryMs:o.sampleEveryMs,reconnectEveryMs:o.reconnectEveryMs,maxBacklog:o.maxBacklog,maxOwnedChildren:o.maxOwnedChildren,idleMs:o.idleMs }; }
async function preservedSource(checkout, expectedCommit) {
  if (typeof checkout !== 'string' || !isAbsolute(checkout) || !/^[a-f0-9]{40}$/.test(expectedCommit ?? '')) throw new Error('missing preserved source');
  const root = await realpath(checkout);
  const top = (await git(root, 'rev-parse', '--show-toplevel')).trim();
  const head = (await git(root, 'rev-parse', 'HEAD')).trim();
  // 中文：不能仅信任 result.json 自报的 commit，必须核验保留的 Git checkout。
  if (top !== root || head !== expectedCommit || (await git(root, 'status', '--porcelain', '--untracked-files=no')).trim()) throw new Error('source identity changed');
  return root;
}
async function buildHash(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('missing preserved build artifact');
  return createHash('sha256').update(await readFile(await realpath(path))).digest('hex');
}
async function verifiedProvenance(checkout, buildArtifactPath, commit, artifactRoot) {
  const sourceCheckout = await preservedSource(checkout,commit);
  const build = await realpath(buildArtifactPath);
  if (inside(artifactRoot,sourceCheckout) || inside(artifactRoot,build)) throw new Error('provenance cannot be disposable fixture');
  return {sourceCheckout,buildArtifactPath:build,buildSha256:await buildHash(build)};
}
// 中文：只比较有明确窗口、数据集和逐次采样时间的实际测量，不能将快测冒充基准。
function validMeasurement(run) {
  const m = run.measurement, samples = run.samples;
  return m && m.datasetId === run.config?.benchmarkDatasetId && m.windowMs === run.config?.durationMs &&
    m.startedAtElapsedMs === 0 && Number.isFinite(m.endedAtElapsedMs) &&
    m.endedAtElapsedMs === run.elapsedMs && run.elapsedMs >= m.windowMs &&
    Array.isArray(samples?.elapsedMs) && samples.elapsedMs.length > 0 &&
    samples.elapsedMs.length === samples.typedInputMs?.length &&
    samples.elapsedMs.at(-1) >= m.windowMs &&
    samples.elapsedMs.every((t,i) => Number.isFinite(t) && t >= 0 && t <= m.endedAtElapsedMs && (i === 0 || t >= samples.elapsedMs[i-1]));
}
async function comparison(path, result) {
  if (!path) return {status:'missing-baseline'};
  if (result.mode !== 'benchmark') return {status:'incomparable-baseline'};
  const base = JSON.parse(await readFile(path,'utf8'));
  const a = base.metadata, b = result.metadata;
  if (!a || !b || !['latency-baseline-pending','latency-measured'].includes(base.status) ||
    base.mode !== 'benchmark' || base.machine !== result.machine || JSON.stringify(base.config) !== JSON.stringify(result.config) ||
    a.driverVersion !== b.driverVersion || a.delivery !== b.delivery || a.productionCommit === b.productionCommit ||
    !validMeasurement(base) || !validMeasurement(result) ||
    !Number.isFinite(result.elapsedMs) || result.elapsedMs < result.config.durationMs ||
    !Array.isArray(base.samples?.typedInputMs) || !Array.isArray(base.samples?.sessionSwitchMs) ||
    !base.samples.typedInputMs.length || base.samples.typedInputMs.length !== base.samples.sessionSwitchMs.length ||
    !result.samples.typedInputMs.length || result.samples.typedInputMs.length !== result.samples.sessionSwitchMs.length || !base.p95?.typedInputMs || !base.p95?.sessionSwitchMs ||
    base.p95.typedInputMs !== p95(base.samples.typedInputMs) || base.p95.sessionSwitchMs !== p95(base.samples.sessionSwitchMs) ||
    !base.samples.typedInputMs.every(x => Number.isFinite(x) && x >= 0) ||
    !base.samples.sessionSwitchMs.every(x => Number.isFinite(x) && x >= 0) ||
    !Number.isFinite(result.p95.typedInputMs) || !Number.isFinite(result.p95.sessionSwitchMs) ||
    result.p95.typedInputMs !== p95(result.samples.typedInputMs) || result.p95.sessionSwitchMs !== p95(result.samples.sessionSwitchMs)) return {status:'incomparable-baseline'};
  try {
    if (inside(resolve(base.artifacts),a.sourceCheckout) || inside(resolve(base.artifacts),a.buildArtifactPath) || inside(result.artifacts,b.sourceCheckout) || inside(result.artifacts,b.buildArtifactPath) ||
      await preservedSource(a.sourceCheckout,a.productionCommit) !== a.sourceCheckout ||
      await buildHash(a.buildArtifactPath) !== a.buildSha256 ||
      await preservedSource(b.sourceCheckout,b.productionCommit) !== b.sourceCheckout ||
      await buildHash(b.buildArtifactPath) !== b.buildSha256) return {status:'incomparable-baseline'};
  } catch { return {status:'incomparable-baseline'}; }
  const typedInputRatio = result.p95.typedInputMs / base.p95.typedInputMs;
  const sessionSwitchRatio = result.p95.sessionSwitchMs / base.p95.sessionSwitchMs;
  if (!Number.isFinite(typedInputRatio) || !Number.isFinite(sessionSwitchRatio)) return {status:'incomparable-baseline'};
  return {status: typedInputRatio > LATENCY_BUDGET || sessionSwitchRatio > LATENCY_BUDGET ? 'over-budget' : 'within-budget',baselineCommit:a.productionCommit,budget:LATENCY_BUDGET,typedInputRatio,sessionSwitchRatio};
}

// Ownership exists before open; disposer must also handle a launch before child registration.
function cleanupRegistry(driver) {
  const callbacks = [], children = [];
  let disposed = false;
  return {
    registerCleanup(fn) {
      if (disposed || typeof fn !== 'function') throw new Error('invalid cleanup registration');
      callbacks.push(fn);
    },
    registerChild(child) {
      if (disposed || !child || typeof child.kill !== 'function' || typeof child.once !== 'function' || !Number.isSafeInteger(child.pid) || child.pid <= 0) throw new Error('invalid owned child');
      const closed = new Promise(resolve => child.once('close', resolve));
      children.push({child,closed});
    },
    async dispose() {
      if (disposed) return {registeredChildrenExited:children.length,failed:true};
      disposed = true;
      let failed = false, exitedCount = 0;
      const deadline = performance.now() + CLEANUP_DEADLINE_MS;
      // 中文：不可信的清理回调有失败截止期；超时只记录失败，不能充当子进程退出证明。
      const bounded = async fn => {
        let timer;
        try {
          const operation = Promise.resolve().then(fn).then(() => true, () => false);
          const remaining = Math.max(0, deadline - performance.now());
          if (!remaining) { failed = true; return; }
          const done = await Promise.race([operation,
            new Promise(resolve => { timer = setTimeout(() => resolve(false), remaining); })]);
          if (!done) failed = true;
        } finally { clearTimeout(timer); }
      };
      for (const fn of callbacks.reverse()) await bounded(fn);
      await bounded(() => driver.dispose());
      for (const {child,closed} of children) {
        try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM'); } catch { failed = true; }
        let timer;
        let exited = await Promise.race([closed.then(() => true),new Promise(resolve => { timer = setTimeout(() => resolve(false),5000); })]);
        clearTimeout(timer);
        if (!exited) {
          failed = true;
          try { child.kill('SIGKILL'); } catch { failed = true; }
          exited = await Promise.race([closed.then(() => true),new Promise(resolve => { timer = setTimeout(() => resolve(false),5000); })]);
          clearTimeout(timer);
        }
        if (exited && (child.exitCode !== null || child.signalCode !== null)) exitedCount++;
        else failed = true;
      }
      return {registeredChildrenExited:exitedCount,failed};
    },
  };
}

async function existingAncestor(path) {
  let cursor = path;
  while (true) {
    try { return await realpath(cursor); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    const parent = dirname(cursor);
    if (parent === cursor) throw new Error('cannot resolve artifact ancestor');
    cursor = parent;
  }
}
async function rejectGitArtifactLocation(path) {
  const enclosingGit = await git(path, 'rev-parse', '--show-toplevel').then(() => true, () => false);
  const enclosingBare = await git(path, 'rev-parse', '--is-inside-git-dir').then(value => value.trim() === 'true', () => false);
  if (enclosingGit || enclosingBare) throw new Error('artifact base must be outside all Git checkouts');
}

async function prepareArtifactBase(base) {
  const cwd = await realpath(process.cwd());
  if (inside(cwd, base) || inside(base, cwd)) throw new Error('artifact base must be outside the project checkout');
  const ancestor = await existingAncestor(base);
  if (inside(cwd, ancestor)) throw new Error('artifact base must be outside the project checkout');
  await rejectGitArtifactLocation(ancestor);
  await mkdir(base, { recursive:true });
  const baseReal = await realpath(base);
  if (inside(baseReal, cwd) || inside(cwd, baseReal)) throw new Error('artifact base must be outside the project checkout');
  await rejectGitArtifactLocation(baseReal);
  return baseReal;
}

export function isolatedEnvironment(current, paths) {
  const allowed = Object.fromEntries(['PATH','LANG','LC_ALL','TZ'].filter(key => current[key] !== undefined).map(key => [key,current[key]]));
  return {...allowed,HOME:paths.home,XDG_CONFIG_HOME:paths.xdgConfig,XDG_DATA_HOME:paths.xdgData,ZCODE_DATA_BASE_DIR:paths.desktopUserData,TMPDIR:paths.temporary ?? paths.home};
}
function applyIsolation(paths) {
  const next = isolatedEnvironment(process.env, paths);
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env,next);
}

export async function runLoad(input = {}) {
  const o = validateOptions(input);
  if (!input.driver || typeof input.driver.open !== 'function' || typeof input.driver.dispose !== 'function') throw new Error('production driver with top-level disposer required');
  if (o.mode === 'acceptance' && input.isolateProcessEnv !== true) throw new Error('acceptance requires isolated launch environment');
  const base = resolve(input.artifactBase ?? tmpdir());
  const baseReal = await prepareArtifactBase(base);
  const root = await mkdtemp(join(baseReal, 'load-'));
  const paths = await isolation(root);
  if (input.isolateProcessEnv) applyIsolation(paths);
  const result = { mode:o.mode, status:'failed', artifacts:root, machine, config:configOf(o), metadata:null, discovered:0, expanded:0, sessions:0, committedEvents:0, reconnects:0, elapsedMs:0, samples:{typedInputMs:[],sessionSwitchMs:[],sessionIds:[],elapsedMs:[]}, measurement:null, p95:{typedInputMs:null,sessionSwitchMs:null}, backlog:[], backlogSummary:null, memory:[], cleanup:null, comparison:{status:'missing-baseline'}, gateway:{status:'unsupported'}, unsupported:['live-provider-latency-not-measured','paid-provider-not-used','ssh-not-used','desktop-and-web-require-separate-runs'], failures:[] };
  let mount, start, startingEvents = 0, phase = 'fixture';
  const cleanup = cleanupRegistry(input.driver);
  const takeFacts = async phase => {
    const facts = validateProductFacts(await mount.facts(), {mode:o.mode,phase});
    if (facts.backlogHighWater > o.maxBacklog || facts.childProcesses > o.maxOwnedChildren) throw new Error('owner backlog/process bound exceeded');
    result.backlog.push({phase,elapsedMs:start ? performance.now()-start : 0, count:facts.backlog, highWater:facts.backlogHighWater});
    result.memory.push({phase,elapsedMs:start ? performance.now()-start : 0,heapBytes:facts.heapBytes,rssBytes:facts.rssBytes,processes:facts.processes ?? null,childProcesses:facts.childProcesses});
    return facts;
  };
  try {
    const fixture = await createFixture(root, o.worktreeCount);
    phase = 'driver-open';
    mount = await input.driver.open({root,repo:fixture.repo,worktrees:fixture.worktrees,artifacts:root,isolation:paths,mode:o.mode,registerCleanup:cleanup.registerCleanup,registerChild:cleanup.registerChild});
    for (const name of ['discover','mount','emit','sample','detach','reconnect','facts','close']) if (typeof mount?.[name] !== 'function') throw new Error(`missing production hook ${name}`);
    metadataCheck(mount.metadata, paths, o.mode);
    result.metadata = {productionCommit:mount.metadata.productionCommit,driverVersion:mount.metadata.driverVersion};
    // Smoke stubs remain incomparable unless both independently verified sources are provided.
    if (input.sourceCheckout || input.buildArtifactPath || o.mode === 'acceptance') {
      phase = 'source-provenance';
      Object.assign(result.metadata,await verifiedProvenance(input.sourceCheckout,input.buildArtifactPath,mount.metadata.productionCommit,root));
    }
    phase = 'discovery';
    const discovered = await mount.discover({repo:fixture.repo,candidates:fixture.worktrees});
    if (!Array.isArray(discovered) || discovered.length !== o.worktreeCount || new Set(discovered.map(c=>c.id)).size !== discovered.length || fixture.worktrees.some(w=>!discovered.some(c=>c.path===w))) throw new Error('production discovery did not return real candidates');
    result.discovered = discovered.length;
    const expanded = discovered.slice(0,o.expandedCount);
    const sessions = Array.from({length:o.sessionCount},(_,i)=>({ id:`synthetic-${i}`,workspaceId:expanded[i % expanded.length].id }));
    phase = 'mount';
    const mounted = await mount.mount({expandedWorktrees:expanded,sessions});
    if (JSON.stringify(mounted?.mountedSurfaces) !== JSON.stringify(['Shell','ProjectSidebar','SessionPane']) || mounted.owner !== 'durable-host' || mounted.delivery !== o.delivery) throw new Error('real mounted Shell/ProjectSidebar/SessionPane + durable Host required');
    if (o.mode === 'acceptance' && ['shellVisible','sidebarVisible','paneVisible','hostJournalReopened'].some(key=>mounted.mountEvidence?.[key] !== true)) throw new Error('missing mounted product evidence');
    result.metadata.delivery = mounted.delivery;
    result.expanded = expanded.length; result.sessions = sessions.length;
    startingEvents = (await takeFacts('start')).durableEvents;
    start = performance.now();
    let nextSample = 0, nextReconnect = o.reconnectEveryMs;
    for (let i=0;i<o.eventCount;i++) {
      const due = o.durationMs * i / o.eventCount;
      const remaining = due - (performance.now()-start);
      if (remaining > 1) await sleep(remaining);
      const session = sessions[i % sessions.length];
      phase = 'emit';
      await mount.emit({sessionId:session.id,eventId:`synthetic-event-${i}`});
      result.committedEvents++;
      const elapsed = performance.now()-start;
      if (elapsed >= nextSample) {
        phase = 'mounted-sample';
        const sampledId = sessions[result.samples.sessionIds.length % sessions.length].id;
        const sample = await mount.sample({sessionId:sampledId}); checkSample(sample);
        result.samples.sessionIds.push(sampledId); result.samples.elapsedMs.push(performance.now()-start);
        result.samples.typedInputMs.push(sample.typedInputMs); result.samples.sessionSwitchMs.push(sample.sessionSwitchMs);
        await takeFacts('sample'); nextSample = elapsed + o.sampleEveryMs;
      }
      if (elapsed >= nextReconnect) {
        phase = 'detach-reconnect';
        await mount.detach();
        const reconnection = await mount.reconnect();
        if (reconnection?.replayedWithoutResend !== true || reconnection?.caughtUp !== true) throw new Error('reconnect did not prove replay without prompt resend');
        result.reconnects++;
        await takeFacts('reconnect'); nextReconnect = elapsed + o.reconnectEveryMs;
      }
    }
    while (performance.now()-start < o.durationMs) await sleep(Math.min(1000,o.durationMs-(performance.now()-start)));
    if (o.mode === 'benchmark') {
      // 中文：基准窗口终点必须有实际挂载交互样本，不能用等待计时器填充延迟证据。
      phase = 'mounted-sample';
      const sampledId = sessions[result.samples.sessionIds.length % sessions.length].id;
      const sample = await mount.sample({sessionId:sampledId}); checkSample(sample);
      result.samples.sessionIds.push(sampledId); result.samples.elapsedMs.push(performance.now()-start);
      result.samples.typedInputMs.push(sample.typedInputMs); result.samples.sessionSwitchMs.push(sample.sessionSwitchMs);
      await takeFacts('sample');
    }
    result.elapsedMs = performance.now()-start;
    phase = 'final-owner-facts';
    const facts = await takeFacts('end');
    if (facts.durableEvents - startingEvents < o.eventCount || facts.backlog !== 0) throw new Error('Host events not durably caught up');
    if (result.reconnects < 1) throw new Error('no detach/reconnect exercised');
    if (o.mode === 'acceptance' && (result.reconnects < 2 || result.samples.typedInputMs.length < 20 || new Set(result.samples.sessionIds).size < o.sessionCount)) throw new Error('insufficient acceptance interaction/reconnect samples');
    if (typeof mount.gatewayProbe === 'function') {
      phase = 'fake-provider-probe';
      const values = await mount.gatewayProbe();
      if (!Array.isArray(values) || values.length < 1) throw new Error('invalid Fake Provider probe');
      for (const value of values) if (!Number.isFinite(value) || value < 0) throw new Error('invalid Fake Provider latency');
      result.gateway = {status:'fake-provider-pure-adapter',samples:values.length,p95Ms:p95(values)};
    }
  } catch { result.failures.push(`gate-failed:${phase}`); }
  finally {
    if (start && !result.elapsedMs) result.elapsedMs = performance.now()-start;
    if (mount) {
      // 中文：close 卡住时仍必须推进注册子进程的紧急回收，不能把计时器当清理成功。
      let timer;
      const closed = await Promise.race([Promise.resolve().then(() => mount.close()).then(() => true, () => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), CLEANUP_DEADLINE_MS); })]);
      clearTimeout(timer);
      if (!closed) result.failures.push('gate-failed:cleanup-or-idle');
    }
    try {
      const exits = await cleanup.dispose();
      result.cleanup = {registeredChildrenExited:exits.registeredChildrenExited};
      if (exits.failed) throw new Error('owned resource cleanup unproven');
      if (mount && !result.failures.includes('gate-failed:cleanup-or-idle')) {
        const after = await takeFacts('post-cleanup');
        if (after.childProcesses !== 0) throw new Error('owned child processes remained after cleanup');
        if (o.idleMs) await sleep(o.idleMs);
        const idle = await takeFacts('post-idle');
        if (idle.childProcesses !== 0) throw new Error('owned child processes remained at idle');
        Object.assign(result.cleanup,{childProcesses:idle.childProcesses,idleHeapBytes:idle.heapBytes,idleRssBytes:idle.rssBytes});
      }
    } catch { result.failures.push('gate-failed:cleanup-or-idle'); }
    result.p95 = {typedInputMs:p95(result.samples.typedInputMs),sessionSwitchMs:p95(result.samples.sessionSwitchMs)};
    if (o.mode === 'benchmark') result.measurement = {datasetId:o.benchmarkDatasetId,windowMs:o.durationMs,startedAtElapsedMs:0,endedAtElapsedMs:result.elapsedMs};
    if (result.backlog.length) result.backlogSummary = {max:Math.max(...result.backlog.map(b=>b.highWater)),final:result.backlog.findLast(b=>b.phase==='end')?.count ?? null};
    try { result.comparison = await comparison(input.baselinePath,result); } catch { result.failures.push('gate-failed:baseline-unreadable'); }
    if (result.comparison.status === 'over-budget') result.failures.push('gate-failed:latency-regression');
    if (!result.failures.length) result.status = o.mode === 'smoke' ? 'smoke-only' : o.mode === 'benchmark' ? result.comparison.status === 'within-budget' ? 'latency-measured' : 'latency-baseline-pending' : 'load-measured-baseline-pending';
    const file = join(root,'result.json'); await writeFile(file+'.partial',JSON.stringify(result,null,2)+'\n'); await rename(file+'.partial',file);
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const val = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i+1]; };
  const driverPath = val('--driver');
  if (!driverPath || !isAbsolute(driverPath)) throw new Error('--driver requires an absolute trusted .mjs path (no built-in production driver)');
  // Fail-fast before importing the driver: isolate launch environment, never inherit account credentials.
  const mode = val('--mode') ?? 'acceptance';
  const delivery = val('--delivery') ?? 'desktop-continuous';
  if (['smoke','benchmark'].includes(mode) && (val('--duration-ms') === undefined || val('--events') === undefined)) throw new Error(`${mode} requires explicit --duration-ms and --events`);
  const numbers = { '--duration-ms':'durationMs', '--events':'eventCount', '--worktrees':'worktreeCount', '--sessions':'sessionCount', '--expanded':'expandedCount', '--sample-every-ms':'sampleEveryMs', '--reconnect-every-ms':'reconnectEveryMs', '--idle-ms':'idleMs', '--max-backlog':'maxBacklog', '--max-owned-children':'maxOwnedChildren' };
  const numeric = Object.fromEntries(Object.entries(numbers).filter(([flag]) => val(flag) !== undefined).map(([flag,key])=>[key,Number(val(flag))]));
  const options = validateOptions({mode,delivery,benchmarkDatasetId:val('--benchmark-dataset-id'),...numeric});
  const base = resolve(val('--artifact-base') ?? tmpdir());
  const safeBase = await prepareArtifactBase(base);
  const launch = await mkdtemp(join(safeBase,'load-launch-'));
  const launchPaths = await isolation(launch);
  applyIsolation(launchPaths);
  const driver = (await import(pathToFileURL(driverPath).href)).default;
  const result = await runLoad({driver,...options,artifactBase:base,baselinePath:val('--baseline'),sourceCheckout:val('--source-checkout'),buildArtifactPath:val('--build-artifact'),isolateProcessEnv:true});
  console.log(JSON.stringify({status:result.status,artifacts:result.artifacts,elapsedMs:Math.round(result.elapsedMs),failures:result.failures}));
  if (result.status === 'failed') process.exitCode = 1;
}
