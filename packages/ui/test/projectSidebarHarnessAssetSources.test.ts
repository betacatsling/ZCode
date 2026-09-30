import assert from "node:assert/strict";
import test from "node:test";
import {
  loadHarnessAssetWithLocalFallback,
  readProjectSidebarHarnessStaticAsset,
} from "../src/project-sidebar/harnessAssetSources.js";

test("local fallback covers Host manifest icon IDs for pi/codex/claude/devin", () => {
  for (const assetId of [
    "pi-light",
    "pi-dark",
    "codex-light",
    "codex-dark",
    "claude-code-light",
    "claude-code-dark",
    "devin-light",
    "devin-dark",
  ]) {
    const asset = readProjectSidebarHarnessStaticAsset(assetId);
    assert.ok(asset, assetId);
    assert.equal(asset.assetId, assetId);
    assert.equal(asset.mediaType, "image/svg+xml");
    assert.match(asset.content, /^<svg\b/i);
  }
});

test("unknown asset IDs stay null (not a hardcoded harness directory)", () => {
  assert.equal(readProjectSidebarHarnessStaticAsset("unknown-harness-light"), null);
  assert.equal(readProjectSidebarHarnessStaticAsset("../escape"), null);
});

test("Host asset wins over local initials fallback", async () => {
  const hostAsset = {
    assetId: "codex-light",
    mediaType: "image/svg+xml" as const,
    content: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#00f"/></svg>`,
  };
  const loaded = await loadHarnessAssetWithLocalFallback(async () => hostAsset, "codex-light");
  assert.equal(loaded, hostAsset);
});

test("local fallback used when Host returns null", async () => {
  const loaded = await loadHarnessAssetWithLocalFallback(async () => null, "devin-light");
  assert.ok(loaded);
  assert.equal(loaded?.assetId, "devin-light");
});
