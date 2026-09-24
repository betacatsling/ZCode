import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { iconAssetIdSchema } from "@zcode/shared/agent-host";
import {
  nativeHarnessAssetMetadata,
  resolveHarnessAsset,
  validateTrustedPng,
} from "../src/harness-assets/index.js";

const png = await readFile(new URL("../src/harness-assets/assets/zcode.png", import.meta.url));

test("fixed trusted mapping serves only bounded packaged PNG, metadata is not execution registry", async () => {
  assert.equal(validateTrustedPng(png).mimeType, "image/png");
  assert.deepEqual(nativeHarnessAssetMetadata.zcode.icon, {
    light: "builtin:zcode",
    dark: "builtin:zcode",
  });
  for (const id of ["pi", "codex", "claude"]) {
    assert.equal(nativeHarnessAssetMetadata[id]?.icon, undefined);
  }
  const resource = await resolveHarnessAsset("builtin:zcode");
  assert.equal(resource?.kind, "trusted-png");
  assert.deepEqual(Buffer.from(resource!.base64, "base64"), png);
  for (const id of [
    "builtin:missing",
    "https://evil/icon.svg",
    "../secret",
    "builtin:../../secret",
    "data:image/png;base64,AAAA",
  ]) {
    assert.equal(await resolveHarnessAsset(id), undefined);
  }
  assert.equal(iconAssetIdSchema.safeParse("builtin:zcode").success, true);
});

test("invalid, oversized, truncated and malicious SVG bytes fail closed", () => {
  const svg = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="https://evil.test/collect"/></svg>',
  );
  for (const bytes of [
    svg,
    Buffer.alloc(256 * 1024 + 1),
    png.subarray(0, 35),
    Buffer.concat([png, svg]),
  ]) {
    assert.throws(() => validateTrustedPng(bytes));
  }
  const invalidDimensions = Buffer.from(png);
  invalidDimensions.writeUInt32BE(4096, 16);
  assert.throws(() => validateTrustedPng(invalidDimensions));
  const badChunk = Buffer.from(png);
  badChunk.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => validateTrustedPng(badChunk));
});
