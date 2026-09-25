import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const cli = resolve(process.cwd(), "scripts/e2e/multi-harness/load/runner.mjs");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function createSource(root, name) {
  const sourceCheckout = await realpath(root).then((canonical) => join(canonical, name));
  await mkdir(sourceCheckout);
  git(sourceCheckout, "init", "-q");
  await writeFile(join(sourceCheckout, "source.txt"), `${name}\n`);
  git(sourceCheckout, "add", "source.txt");
  git(
    sourceCheckout,
    "-c",
    "user.name=Load Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    name,
  );
  const commit = git(sourceCheckout, "rev-parse", "HEAD");
  const buildArtifactPath = join(await realpath(root), `${name}.bundle`);
  const buildBytes = Buffer.from(`disposable test artifact ${name}\n`);
  await writeFile(buildArtifactPath, buildBytes);
  const buildProvenancePath = join(root, `${name}.provenance.json`);
  await writeFile(
    buildProvenancePath,
    JSON.stringify({
      kind: "preserved-baseline-desktop-bundle-preparation",
      status: "built-unmounted",
      sourceCheckout,
      productionCommit: commit,
      postBuildCommit: commit,
      steps: [{ exit: 0 }],
      artifactFiles: [
        { path: relative(sourceCheckout, buildArtifactPath), sha256: sha256(buildBytes) },
      ],
    }),
  );
  return { sourceCheckout, commit, buildArtifactPath, buildProvenancePath };
}

async function createDriver(
  root,
  {
    mutateSource = false,
    mutateDriver = false,
    mutateBuild = false,
    productionVersion = false,
  } = {},
) {
  const driverPath = join(root, "trusted-test-driver.mjs");
  await writeFile(
    driverPath,
    `import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
let mutated=false;
export default {
  async dispose() {},
  async open(input) {
    let events=0;
    const productionCommit=input.sourceCheckout ? execFileSync('git',['rev-parse','HEAD'],{cwd:input.sourceCheckout,encoding:'utf8'}).trim() : '${"a".repeat(40)}';
    return {
      metadata:{productionCommit,driverVersion:'${productionVersion ? "production-driver-1" : "contract-stub"}',paths:input.isolation},
      async discover({candidates}) {return candidates.map((path,index)=>({id:'candidate-'+index,path}));},
      async mount() {return {mountedSurfaces:['Shell','ProjectSidebar','SessionPane'],owner:'durable-host',delivery:input.delivery};},
      async emit() {events++;},
      async sample() {
        if (${mutateSource} && !mutated) {mutated=true; await writeFile(join(input.sourceCheckout,'source.txt'),'changed during measurement\\n');}
        if (${mutateDriver} && !mutated) {mutated=true; await writeFile(${JSON.stringify(driverPath)},'changed after import\\n');}
        if (${mutateBuild} && !mutated) {mutated=true; await writeFile(input.buildArtifactPath,'changed after startup\\n');}
        return {typedInputMs:5,sessionSwitchMs:6,focusStable:true,draftStable:true,selectedStable:true,worktreesStable:true};
      },
      async detach() {},
      async reconnect() {return {replayedWithoutResend:true,caughtUp:true};},
      async facts() {return {durableEvents:events,backlog:0,backlogHighWater:0,implicitCliStarts:0,fullHistorySidebarReads:0,worktreeMutations:0,childProcesses:0,acceptedPrompts:0,focusStable:true,draftStable:true,selectedStable:true,heapBytes:1024,rssBytes:2048};},
      async close() {},
    };
  },
};
`,
  );
  return driverPath;
}

function argsFor({
  driverPath,
  artifactBase,
  mode = "benchmark",
  source,
  baselinePath,
  ...options
}) {
  const args = [cli, "--driver", driverPath, "--artifact-base", artifactBase, "--mode", mode];
  if (mode === "benchmark") args.push("--benchmark-dataset-id", "load-cli-regression-v1");
  const values = {
    "duration-ms": 500,
    events: 4,
    worktrees: 2,
    sessions: 2,
    expanded: 1,
    "sample-every-ms": 25,
    "reconnect-every-ms": 50,
    "idle-ms": 0,
    ...options,
  };
  for (const [name, value] of Object.entries(values)) args.push(`--${name}`, String(value));
  if (source)
    args.push(
      "--source-checkout",
      source.sourceCheckout,
      "--build-artifact",
      source.buildArtifactPath,
      "--build-provenance",
      source.buildProvenancePath,
    );
  if (baselinePath) args.push("--baseline", baselinePath);
  return args;
}

function run(args) {
  const child = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.signal, null, child.stderr);
  const output = child.stdout.trim().split("\n").at(-1);
  let summary;
  try {
    summary = JSON.parse(output);
  } catch {
    assert.fail(`CLI did not report JSON: ${child.stdout} ${child.stderr}`);
  }
  return { code: child.status, summary, stderr: child.stderr };
}

async function withRoot(callback) {
  const root = await mkdtemp(join(tmpdir(), "load-cli-regression-"));
  try {
    await callback(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("CLI returns nonzero and reports the same outcome for an explicitly requested missing baseline", async () =>
  withRoot(async (root) => {
    const driverPath = await createDriver(root);
    const output = run(
      argsFor({
        driverPath,
        artifactBase: join(root, "artifacts"),
        mode: "smoke",
        baselinePath: join(root, "missing-baseline.json"),
        "duration-ms": 200,
        events: 4,
        "sample-every-ms": 1,
        "reconnect-every-ms": 1,
      }),
    );
    assert.equal(output.code, 1);
    assert.equal(output.summary.status, "failed");
    assert.equal(output.summary.exitCode, output.code);
    const result = JSON.parse(
      await readFile(join(output.summary.artifacts, "result.json"), "utf8"),
    );
    assert.ok(result.failures.includes("gate-failed:baseline-unreadable"));
  }));

test("CLI rejects a forged baseline schema as explicit non-pass, not smoke success", async () =>
  withRoot(async (root) => {
    const driverPath = await createDriver(root);
    const baselinePath = join(root, "forged-baseline.json");
    await writeFile(
      baselinePath,
      JSON.stringify({ schemaVersion: 999, status: "latency-measured" }),
    );
    const output = run(
      argsFor({
        driverPath,
        artifactBase: join(root, "artifacts"),
        mode: "smoke",
        baselinePath,
        "duration-ms": 200,
        events: 4,
        "sample-every-ms": 1,
        "reconnect-every-ms": 1,
      }),
    );
    assert.equal(output.code, 2);
    assert.equal(output.summary.status, "baseline-incomparable");
    assert.equal(output.summary.exitCode, output.code);
  }));

test("CLI never reports contract stub p95 as a measured product comparison", async () =>
  withRoot(async (root) => {
    const driverPath = await createDriver(root);
    const source = await createSource(root, "candidate");
    const output = run(argsFor({ driverPath, artifactBase: join(root, "artifacts"), source }));
    assert.equal(output.code, 2, JSON.stringify(output.summary));
    assert.equal(output.summary.status, "contract-stub-only");
    assert.equal(output.summary.exitCode, output.code);
  }));

test("CLI refuses invalid build provenance before claiming a latency comparison", async () =>
  withRoot(async (root) => {
    const driverPath = await createDriver(root);
    const source = await createSource(root, "candidate");
    await writeFile(source.buildProvenancePath, JSON.stringify({ kind: "forged" }));
    const output = run(argsFor({ driverPath, artifactBase: join(root, "artifacts"), source }));
    assert.equal(output.code, 1);
    assert.equal(output.summary.status, "failed");
    assert.equal(output.summary.exitCode, output.code);
    const result = JSON.parse(
      await readFile(join(output.summary.artifacts, "result.json"), "utf8"),
    );
    assert.ok(result.failures.includes("gate-failed:source-provenance"));
  }));

test("CLI detects source mutation during measurement and exits nonzero", async () =>
  withRoot(async (root) => {
    const driverPath = await createDriver(root, { mutateSource: true });
    const source = await createSource(root, "candidate");
    const output = run(argsFor({ driverPath, artifactBase: join(root, "artifacts"), source }));
    assert.equal(output.code, 1);
    assert.equal(output.summary.status, "failed");
    assert.equal(output.summary.exitCode, output.code);
    const result = JSON.parse(
      await readFile(join(output.summary.artifacts, "result.json"), "utf8"),
    );
    assert.ok(result.failures.includes("gate-failed:source-provenance"));
  }));

test("CLI rejects driver source changes during measurement before persisting a successful artifact", async () =>
  withRoot(async (root) => {
    const driverPath = await createDriver(root, { mutateDriver: true });
    const source = await createSource(root, "candidate");
    const output = run(argsFor({ driverPath, artifactBase: join(root, "artifacts"), source }));
    assert.equal(output.code, 1);
    assert.ok(output.summary.failures.includes("gate-failed:source-provenance"));
  }));

test("CLI rejects consumed build changes during measurement", async () =>
  withRoot(async (root) => {
    const driverPath = await createDriver(root, { mutateBuild: true });
    const source = await createSource(root, "candidate");
    const output = run(argsFor({ driverPath, artifactBase: join(root, "artifacts"), source }));
    assert.equal(output.code, 1);
    assert.ok(output.summary.failures.includes("gate-failed:source-provenance"));
  }));

test("CLI refuses a production-labeled driver loaded outside selected checkout", async () =>
  withRoot(async (root) => {
    const driverPath = await createDriver(root, { productionVersion: true });
    const source = await createSource(root, "candidate");
    const output = run(argsFor({ driverPath, artifactBase: join(root, "artifacts"), source }));
    assert.equal(output.code, 1);
    assert.ok(output.summary.failures.includes("gate-failed:source-provenance"));
  }));

test("CLI comparison rejects runtime-version tampering with explicit nonzero result", async () =>
  withRoot(async (root) => {
    const driverPath = await createDriver(root);
    const baselineSource = await createSource(root, "baseline");
    const baselineRun = run(
      argsFor({
        driverPath,
        artifactBase: join(root, "baseline-artifacts"),
        source: baselineSource,
      }),
    );
    assert.equal(baselineRun.code, 2);
    const baselinePath = join(baselineRun.summary.artifacts, "result.json");
    const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
    baseline.metadata.runtime.nodeVersion = "forged-runtime-version";
    await writeFile(baselinePath, JSON.stringify(baseline));

    const candidateSource = await createSource(root, "candidate");
    const candidate = run(
      argsFor({
        driverPath,
        artifactBase: join(root, "candidate-artifacts"),
        source: candidateSource,
        baselinePath,
      }),
    );
    assert.equal(candidate.code, 2);
    assert.equal(candidate.summary.status, "baseline-incomparable");
    assert.equal(candidate.summary.exitCode, candidate.code);
    const result = JSON.parse(
      await readFile(join(candidate.summary.artifacts, "result.json"), "utf8"),
    );
    assert.equal(result.comparison.reason, "runtime-mismatch");
  }));
