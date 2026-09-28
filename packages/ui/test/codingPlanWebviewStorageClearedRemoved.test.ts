import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import path from "node:path";

const uiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("UI no longer invokes ClearCodingPlanWebviewStorage", () => {
  const files = [
    path.join(uiRoot, "src/root/useRootWorkspaceActions.ts"),
    path.join(uiRoot, "src/settings/ModelProviderSection.tsx"),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.equal(
      text.includes("ClearCodingPlanWebviewStorage"),
      false,
      `${path.basename(file)} still references ClearCodingPlanWebviewStorage`,
    );
  }
});
