import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import path from "node:path";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const libRoot = path.join(uiRoot, "src/lib");
const srcRoot = path.join(uiRoot, "src");

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, acc);
    else if (/\.(ts|tsx|js|mjs|md)$/.test(name)) acc.push(full);
  }
  return acc;
}

test("sidebarCodingPlanUpgrade.ts is removed", () => {
  assert.equal(existsSync(path.join(libRoot, "sidebarCodingPlanUpgrade.ts")), false);
});

test("codingPlanFunnelTelemetry.ts is removed", () => {
  assert.equal(existsSync(path.join(libRoot, "codingPlanFunnelTelemetry.ts")), false);
});

test("no remaining imports of sidebarCodingPlanUpgrade", () => {
  const hits = walkFiles(srcRoot).filter((file) => {
    const text = readFileSync(file, "utf8");
    return text.includes("sidebarCodingPlanUpgrade");
  });
  assert.deepEqual(hits, []);
});
