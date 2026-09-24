import { spawn } from "node:child_process";

/** No saved model config, no credential loader, no paid route. */
export async function runPrivateFake(rootDir) {
  const child = spawn(process.execPath, ["scripts/native-matrix.mjs"], {
    cwd: rootDir,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let proof = "";
  child.stdout.on("data", (chunk) => {
    if (proof.length < 16_000) proof += chunk.toString();
  });
  child.stderr.resume(); // Never print raw child errors.
  const code = await new Promise((done) => child.once("exit", done));
  const match = /native-fake-proof: upstreamHttpRequests=(\d+) modelCallCounter=observed/.exec(
    proof,
  );
  const result = {
    mode: "fake",
    scenarioPassed: code === 0 && !!match,
    fakeHttpAttempts: match ? Number(match[1]) : null,
    privateArtifactScan: code === 0 && proof.includes("native-fake-private-scan: passed"),
    paidCalls: 0,
  };
  console.log(JSON.stringify(result));
  if (!result.scenarioPassed || !result.privateArtifactScan) process.exitCode = 1;
}
