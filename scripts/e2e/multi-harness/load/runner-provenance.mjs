import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { validMeasurement } from "./measurement.mjs";
import { SCHEMA_VERSION, git, hash, inside, p95 } from "./runner-fixture.mjs";
import { comparison as compareBaseline } from "./runner-baseline-comparison.mjs";
export async function preservedSource(checkout, expectedCommit) {
  if (
    typeof checkout !== "string" ||
    !isAbsolute(checkout) ||
    !/^[a-f0-9]{40}$/.test(expectedCommit ?? "")
  )
    throw new Error("missing preserved source");
  const root = await realpath(checkout);
  const top = (await git(root, "rev-parse", "--show-toplevel")).trim();
  const head = (await git(root, "rev-parse", "HEAD")).trim();
  // 中文：不能仅信任 result.json 自报的 commit，必须核验保留的 Git checkout。
  if (
    top !== root ||
    head !== expectedCommit ||
    (await git(root, "status", "--porcelain", "--untracked-files=all")).trim()
  )
    throw new Error("source identity changed");
  return root;
}
export async function buildHash(path) {
  if (typeof path !== "string" || !isAbsolute(path))
    throw new Error("missing preserved build artifact");
  return createHash("sha256")
    .update(await readFile(await realpath(path)))
    .digest("hex");
}
export async function verifiedProvenance(
  checkout,
  buildArtifactPath,
  commit,
  artifactRoot,
  preparationPath,
  driverVersion,
) {
  const sourceCheckout = await preservedSource(checkout, commit);
  const build = await realpath(buildArtifactPath);
  if (inside(artifactRoot, sourceCheckout) || inside(artifactRoot, build))
    throw new Error("provenance cannot be disposable fixture");
  const buildSha256 = await buildHash(build);
  if (!preparationPath && driverVersion !== "contract-stub")
    throw new Error("production build preparation missing");
  let buildPreparation;
  if (preparationPath) {
    const manifestPath = await realpath(preparationPath);
    if (inside(artifactRoot, manifestPath))
      throw new Error("build preparation cannot be disposable");
    const raw = await readFile(manifestPath);
    const manifest = JSON.parse(raw.toString("utf8"));
    const artifact = manifest.artifactFiles?.find(
      (file) => file.path === relative(sourceCheckout, build),
    );
    if (
      manifest.kind !== "preserved-baseline-desktop-bundle-preparation" ||
      manifest.status !== "built-unmounted" ||
      manifest.sourceCheckout !== sourceCheckout ||
      manifest.productionCommit !== commit ||
      manifest.postBuildCommit !== commit ||
      !Array.isArray(manifest.steps) ||
      manifest.steps.length < 1 ||
      manifest.steps.some((step) => step.exit !== 0) ||
      artifact?.sha256 !== buildSha256
    )
      throw new Error("source-to-build preparation unproven");
    buildPreparation = {
      manifestPath,
      manifestSha256: createHash("sha256").update(raw).digest("hex"),
    };
  }
  return {
    sourceCheckout,
    buildArtifactPath: build,
    buildSha256,
    ...(buildPreparation ? { buildPreparation } : {}),
  };
}
export async function verifiedFiles(files) {
  if (
    !Array.isArray(files) ||
    files.length !== 4 ||
    new Set(files.map((file) => file.path)).size !== files.length
  )
    return false;
  return (
    await Promise.all(
      files.map(
        async (file) =>
          typeof file.path === "string" &&
          isAbsolute(file.path) &&
          /^[a-f0-9]{64}$/.test(file.sha256) &&
          hash(await readFile(file.path)) === file.sha256,
      ),
    )
  ).every(Boolean);
}
// Reuse the extracted decision; provenance readers stay here under the runner's single ownership.
export async function comparison(path, result) {
  return compareBaseline(path, result, {
    readFile, hash, verifiedFiles, preservedSource, buildHash, inside, resolve,
    p95, validMeasurement, createHash, schemaVersion: SCHEMA_VERSION,
    latencyBudget: 1.1,
  });
}
