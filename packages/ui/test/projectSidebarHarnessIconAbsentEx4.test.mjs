/**
 * Soft pin: project-sidebar/HarnessIcon.tsx absent (Ex4 Track A).
 * Unloadable harness-chrome remnant — zero importers; live icons are
 * agent-host/HarnessIcon + harness/HarnessIcon. ≠ #266 Devin honesty
 * (services) / ≠ Track B product-login.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const ORPHAN = join(uiSrc, "project-sidebar/HarnessIcon.tsx");
const AGENT_HOST = join(uiSrc, "agent-host/HarnessIcon.tsx");
const HARNESS = join(uiSrc, "harness/HarnessIcon.tsx");
const ASSET_SOURCES = join(uiSrc, "project-sidebar/harnessAssetSources.ts");

test("DROP project-sidebar/HarnessIcon.tsx absent", () => {
  assert.equal(existsSync(ORPHAN), false);
});

test("KEEP agent-host/HarnessIcon still present", () => {
  const src = readFileSync(AGENT_HOST, "utf8");
  assert.match(src, /export function HarnessIcon/);
  assert.match(src, /export function acceptHarnessAssetSource/);
  assert.match(src, /export function resolveHarnessDirectoryIcon/);
});

test("KEEP harness/HarnessIcon still present", () => {
  const src = readFileSync(HARNESS, "utf8");
  assert.match(src, /export function HarnessIcon/);
  assert.match(src, /export type HarnessAssetLoader/);
});

test("KEEP project-sidebar harnessAssetSources still present", () => {
  const src = readFileSync(ASSET_SOURCES, "utf8");
  assert.match(src, /export function readProjectSidebarHarnessStaticAsset/);
  assert.match(src, /export async function loadHarnessAssetWithLocalFallback/);
});
