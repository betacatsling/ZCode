import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import path from "node:path";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcRoot = path.join(uiRoot, "src");
const settingsRoot = path.join(srcRoot, "settings");

function walkFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walkFiles(full, acc);
    else if (/\.(ts|tsx|js|mjs|md)$/.test(name)) acc.push(full);
  }
  return acc;
}

test("CodingPlanEmbeddedWebviewDialog.tsx is removed", () => {
  assert.equal(
    existsSync(path.join(settingsRoot, "CodingPlanEmbeddedWebviewDialog.tsx")),
    false,
  );
});

test("codingPlanEmbeddedWebview.ts helpers are removed", () => {
  assert.equal(
    existsSync(
      path.join(settingsRoot, "model-provider-section/codingPlanEmbeddedWebview.ts"),
    ),
    false,
  );
});

test("no remaining imports of CodingPlanEmbeddedWebviewDialog or codingPlanEmbeddedWebview", () => {
  const hits = walkFiles(srcRoot).filter((file) => {
    const text = readFileSync(file, "utf8");
    return (
      text.includes("CodingPlanEmbeddedWebviewDialog") ||
      text.includes("codingPlanEmbeddedWebview")
    );
  });
  assert.deepEqual(hits, []);
});
