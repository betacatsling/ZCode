/**
 * Soft pin: onOpenModelUpgrade absent from ConversationComposer + SessionPane (Ex4).
 * Does not own tip-ledger / verify-product-login gate / Host / Ex3 / Ex1.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const uiSrc = join(dirname(fileURLToPath(import.meta.url)), "../src");
const COMPOSER = join(uiSrc, "v4/ConversationComposer.tsx");
const SESSION_PANE = join(uiSrc, "v4/SessionPane.tsx");

test("DROP onOpenModelUpgrade absent from ConversationComposer src", () => {
  const src = readFileSync(COMPOSER, "utf8");
  assert.equal(src.includes("onOpenModelUpgrade"), false);
  assert.equal(src.includes("_onOpenModelUpgrade"), false);
});

test("DROP onOpenModelUpgrade absent from SessionPane src", () => {
  const src = readFileSync(SESSION_PANE, "utf8");
  assert.equal(src.includes("onOpenModelUpgrade"), false);
});

test("KEEP onOpenModelSettings still present in ConversationComposer", () => {
  const src = readFileSync(COMPOSER, "utf8");
  assert.match(src, /onOpenModelSettings\?: \(\) => void;/);
});
